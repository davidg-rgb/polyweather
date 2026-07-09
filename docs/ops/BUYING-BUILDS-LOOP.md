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

- **▶ NEXT SESSION (post-/clear, operator-driven):** WS-A is CLOSED; the live threads are WS-B/WS-D infra + WS-C code-eval —
  **(1) °F/°C bidding play — FULLY EXHAUSTED (C10):** °F + °C, flip + hold-to-resolution, EVERY combination is
  efficient net of the real taker cost. The °C 20¢-hold's +1.1% raw ROI was gated (C10) and DIED — city-clustered
  mean **−4.13%**, CI [−26.5%, +18.3%] straddles 0 → **KILL** (the +1.1% was dollar-weighting concentration; per
  city the typical city loses; winFrac 21% is expected for a longshot so `ciLow` is the binding criterion). No 13th
  signal. Reusable: `fahrenheit-blend-grid.ts --unit F|C` + `hold-band-gate.ts`.
  **(1b) NO-FADE (negative convergence, operator-directed, C11–C12) — EXHAUSTED, no edge:** the full buy×sell GRID
  (entry 35–85¢ × exit 70–95¢ + hold, 478k ticks / all 45 cities) → **every one of ~27 cells §9R-E KILLs; ZERO have
  ciLow>0.** Best = buy NO 85¢/HOLD −4.8% [−6.0,−3.6] (still KILL). HOLD always beats FLIP (C7 mechanics); buying NO
  expensive is least-bad (fee-only fair bet), cheap-NO fades favorites (−14 to −47%). Market efficient across the
  entire NO surface. `NO-FADE-RESULTS.md` / `no-fade{,-grid}.ts`.
  **(1c) WS-C /trading bid-logic eval (C13):** `order-intent.ts` maker never-cross + idempotency + fail-safe mode +
  fail-loud parsers are all SOUND + thoroughly tested; fixed one latent asymmetry (`takerLimitPrice` now clamps to
  `[tick,1−tick]` like the maker path). Rail stays DORMANT. **(1d) depth-capture-v2 PARITY CHECK done (C14, WS-B∩WS-D):**
  the deploy's load-bearing de-risk is now OFFLINE-PROVEN — new `supabase/tests/google-repoint-parity.test.ts` shows
  the depth-path RPC drives `buildGoogleView` to a byte-identical panel decision vs the `opening_captures` path on a
  shared event (entry/TP-exit/P&L/gate/TP-grid all equal; guard proves both sources truly exercised). Correctly
  scoped away from the documented population difference (depth cohort smaller by discover cadence — a live-forward
  property). **This raises operator confidence to apply the staged 0089/0088 bundle.** **(1e) WS-C MakerExecutor
  eval (C15):** the `live.ts` maker execution path (place/placeTaker/reprice/reconcile/cancel) is SOUND +
  comprehensively tested (60 cases, 3-round-reviewed); added 3 money-path guard tests (placeTaker double-SELL
  idempotency, taker reserve-race, cancel not-allCanceled abort). Rail stays DORMANT. **▶ ALL GREEN buying-build
  threads are now swept — C16 = light periodic fleet/gate/accrual re-verify, else idle low cadence** (forward motion
  is operator-deploy-gated or §9R-E-accrual-gated). **(2) GOOGLE CONVERGENCE
  PLAY (WS-B — FIRST read done C8):** `/convergence` is LIVE + accruing (89 snaps, */15 firing, cityErrors 0), but
  the §9R-E gate is **INSUFFICIENT_DATA (5/40 markets, 2/7 days)** and the early **+163% ROI is one lucky market**
  (mexico-city held-to-resolution = 83% of P&L; ex-it +$28 on 4) → **noise; no tuning justified until it accrues**
  (~1.7 realized/day → ~24 days to the 40-market gate). The depth-capture-v2 parity check (C14) is DONE; remaining
  WS-B levers are the operator deploy (staged) + forward accrual. Start by reading this doc + the cycle log.
- **On fire? RESOLVED — the C16 statement-timeout incident is FIXED LIVE (C17, operator-directed "apply 0090").**
  The incident (found C16): **~53 job failures/24h, STEADY ~3–4/hr ALL hours** — **health-monitor's `data_freshness`
  RPC ~80% of its */30 ticks + poll-markets' `upsert_market_snapshots` ~5%**, both `statement timeout`. Root cause:
  `data_freshness` (0020) ran `max(captured_at)` over `market_snapshots` (348 MB) + `forecast_snapshots` (279 MB),
  neither captured_at-indexed → **full seq scan every tick** + contention with poll-markets on the same table.
  **FIX APPLIED 2026-07-08 ~20:45Z (operator authorized):** both `captured_at desc` indexes built **CONCURRENTLY**
  (lock-free — no money-path stall; forecast_snapshots as canary, then market_snapshots), both **valid**, migration
  **`0090` recorded** in prod history. **PROVEN:** `explain` shows `max(captured_at)` is now an `Index Only Scan …
  Heap Fetches: 1` (1-row fetch, was a 964k-row seq scan). **CONFIRMED LIVE (C18, 21:23Z): zero failures since the
  20:44Z build** — health-monitor's 21:00Z tick ran `ok` (was ~80% failing) + poll-markets 8/8 `ok` (20:45→21:20).
  Money path untouched; `/convergence` HEALTHY throughout. **Rollback if ever needed:** `drop index
  market_snapshots_captured_idx, forecast_snapshots_captured_idx;`.
- **Branch / state:** `loop/2026-07-08-buying-builds` off `main @ 2491598` (6 depth-capture-v2 commits still
  local/unpushed) + 18 loop commits (latest `e63bcdd`). **Suite 3018 green / typecheck clean** (C14 +7 parity, C15
  +3 MakerExecutor guards, C16 +1 freshness-index). **Prod: migration `0090` APPLIED (C17, operator-directed).**
- **Staged, awaiting your yes/no (operator-gated — Claude will not apply):**
  - **★ depth-capture v2 deploy** (WS-D's one real compute win — built + tested + committed, NOT deployed).
    **NOW PARITY-PROVEN OFFLINE (C14):** `google-repoint-parity.test.ts` proves the cutover is behavior-preserving
    (depth path ≡ opening path on the panel decision), so applying `0088` is de-risked — the only forward unknown
    left is the DOCUMENTED population sparsity (depth's fresh cohort smaller by discover cadence; levers in §6.3).
    Sequence (full detail + verify + rollback in `DEPTH-CAPTURE-V2-HANDOFF.md` §6, re-verified current today +
    cross-checked in `COMPUTE-AUDIT-2026-07-08.md`): **apply `0089` then `0088`** (MCP `apply_migration`) →
    **redeploy `discover-markets` + `depth-capture` edge fns** → let `market_depth` accrue ≥1 day → verify +
    parity-check → auto-cutover at ~200 rows. Self-gating; instant rollback = `update config set value='999999999'
    where key='bot.depthCutoverMinRows'`. Moves the Google panel off `opening_captures` + drops the
    `market_snapshots.depth` v1 column.
  - **✅ 0090 freshness-index fix — DONE (C17, 2026-07-08 ~20:45Z).** Applied the money-path-safe way: both indexes
    built CONCURRENTLY (lock-free) then migration recorded; proven via `Index Only Scan` EXPLAIN. Nothing left for
    the operator here. (Was the highest-priority staged item.)
  - _(WS-A faint cheap-band °F forward panel — only if you pick "forward-panel it" in decision #2; not built yet.)_
- **Decisions I need from you:**
  1. **Deploy-autonomy flip** (offered in chat; default = staged — I do not apply migrations/deploy fns).
  2. **WS-A faint signal:** the blend-centered °F cheap-band (ask ≤12–20¢) showed +0.05–0.06/contract but n=6–23,
     CI-straddles-0 → INSUFFICIENT. Want a **forward paper panel** to accrue those cheap-band °F blend bets to a
     real §9R-E verdict (paper-only, staged for you), or **drop it** as efficient-like-everything-else? My read:
     low priority — the base rate says it regresses to efficient; the °F markets already price the blend.
- **⚠ Compute readings UPDATED (WS-D, C16, live 2026-07-08 ~20Z):** the C4 "0 failures/24h" was a **14Z (off-peak)
  read that missed a persistent all-hours failure** — the true picture is **~53 fails/24h** (health-monitor `data_freshness`
  seq-scan timeouts ~80% + poll-markets `upsert_market_snapshots` ~5%; diagnosed + fixed by `0090`, staged above). The
  TOAST/opening_captures crisis IS still resolved (`opening_captures` 120 MB / 28.3k rows, bounded by its prune; not
  re-growing). But the DB is **NOT fully healthy** until `0090`'s indexes land — the `data_freshness` seq scan is a
  standing load hog. `market_snapshots` 346 MB is the seq-scan victim (0090 indexes it; 0089 drops its sparse v1
  `depth` col but reclaims little — the 346 MB is real snapshot history under retention). **Below (C4) reading kept
  for the non-failure parts (fleet/storage), but the "0 failures / no pause warranted" claim is SUPERSEDED by C16:**
- **Compute readings (WS-D, C4, live 2026-07-08 ~14Z — refreshed audit `COMPUTE-AUDIT-2026-07-08.md`):**
  ~~The crisis is RESOLVED and holding.~~ (failure count superseded by C16 above.) Fleet = 21 jobs, DB-side cron time trivial
  (~200s/day). `opening_captures` **bounded at 97 MB / 22.9k rows** by its daily prune (NOT re-growing toward the
  1.2 GB TOAST trap — that trap was the now-unscheduled 45-city panels). Micro not saturated. **No reversible
  cron pause is warranted** (no dead-signal cron still scheduled — 07-07 culled them). **One forward win: land
  depth-capture v2** (staged above). Storage: `market_snapshots` 346 MB (v1 `depth` col, 0089 drops), dead
  `market_rewards` 140 MB (optional drop, destructive → operator). Open Q for you: post-v2, `opening-capture` may
  be retire-able (handoff keeps it for the dead panels' `houseProb`) — a further lever, your call.
- **WS-A (Fahrenheit test) — COMPLETE (honest KILL/INSUFFICIENT), both halves measured:**
  - **C3a forecast-match:** on the full 396-event/11-city °F universe (ladder bucket-match, lead 1; 77-event
    apples-to-apples): **calibrated blend 84% within-1 / 38% exact vs raw Google 61%/26%**, weatherapi 62%, owm
    52%. Frozen selector: **0/11 cities beat the blend OOS** → OOS TEST (165 ev): Google 61% → **blend 88%.**
    ⇒ "Google + best-matching source" = **bid the blend, not Google** (why raw-Google °F was excluded).
  - **C3b P&L:** but the blend's °F accuracy is **already priced** — netEV/contract **~0 at every band** (best
    +0.05–0.06 at ask ≤12–20¢ but n=6–23, **every CI straddles 0**; win% ≈ avgAsk throughout). Google-centered
    cheap band = **0% wins / 15 bets, CI [−0.071,−0.038]** (the only significant result, a LOSS).
  - **Verdict:** the °F cohort is **efficient w.r.t. the blend** — accurate but no taker edge, consistent with
    all 12 dead signals. No new tradable edge found. Faint cheap-band +EV is INSUFFICIENT (decision #2 above).
  - **Delivered:** 3 reusable, tested instruments — `source-selector.ts` (+12 tests) + `fahrenheit-source-test.ts`
    (forecast-match) + `fahrenheit-source-pnl.ts` (P&L) — that will catch a °F edge if one ever appears forward.
- **Latest headline (C7, operator-requested full entry×exit grid):** the PURE FLIP (buy cheap / sell higher /
  never hold to resolution / dump at last bid if the target never fills) — full grid buy {5,10,15,20,25¢} × sell
  {15..50¢}. **EVERY one of 24 cells loses.** Best by ROI = buy 25¢/sell 30¢ (71% win, −$267, −16.6%); by net$ =
  buy 15¢/sell 20¢ (60% win, −$261, −22.7%). Mechanism: flip caps winner gain at the small (X−E) spread while
  non-completers dump near $0 → break-even needs >80% completion, market gives ≤71%. **Strictly worse than
  holding** (not-holding forfeits the $1 on the ~9.5% true winners). No profitable entry/exit exists — efficient.
- **(prior C6 headline) stop-loss + sweep:** decomposed 3 configs × 6 entry bands on the
  real book. **Widening the entry to 10–20¢ HELPS (−7.6% → −1.1%, 57.7% win — near break-even); the stop-loss
  below 10¢ HURTS (~$35/band worse — it cuts volatile buckets that dip then recover to 30¢); removing the 24h
  window is CATASTROPHIC (−26% to −31% — late falling-knife entries, ~80% stop out).** Best variant found = buy
  **10–20¢, keep 24h window, NO stop-loss, sell 30¢ = −1.1%** — still a small loss; nothing tips positive.
  Appended to `FAHRENHEIT-BLEND-REPLAY-RESULTS.md`; engine `fahrenheit-blend-sweep.ts`.
- **(prior C5 headline) operator replay:** the house-blend **buy 10–15¢ / sell 30¢** °F play,
  replayed on the real per-tick book (`market_snapshots`, all °F cities): **42 positions, 42.9% win-rate, net
  −$32 maker / −$46 taker (ROI −7.6% / −11%)** — loses, narrowly (break-even 44.6%). Cheap house-favored buckets
  pop (43% touch 30¢) but win only **9.5%** at resolution → adverse selection, efficiently priced; the 30¢ TP
  helps 4× vs holding (−$133) but can't reach +EV. Full deliverable: **`FAHRENHEIT-BLEND-REPLAY-RESULTS.md`**.

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
- **C1 (2026-07-08):** Loop branch created (`b44f4e9`). **WS-D compute probe (light stat views):** top
  exec-time hog = `convergence_capture_inputs`/`opening_captures` TOAST reads (stats since 07-06, so partly
  pre-cull) → confirms depth-capture v2 is the biggest compute win; storage leaders `market_snapshots` 346 MB
  (v1 `depth` column, dropped by 0089) + dead-signal `market_rewards` 140 MB. Recorded in the operator block.
  **WS-A grounding launched:** an agent is digesting `GOOGLE-FAHRENHEIT-INVESTIGATION.md` +
  `google-fahrenheit-diagnostic.ts`/`google-f-biascorrect.ts` + `source-accuracy-findings.ts` +
  `check-source-accuracy.ts`/`source_accuracy` + the `buildGoogleView` injection point, to return the reusable
  pieces + the precise gap before I write the selector. Next (C2): consume that brief → build the per-city
  best-matching-source selector (frozen TRAIN→TEST, must beat raw-Google AND the blend OOS) + tests.
- **C2 (2026-07-08):** WS-A grounding landed (engine reusable verbatim; `source_accuracy` scores °C-MAE not the
  °F-ladder metric; injection point = `google-bucket-view.ts:288`; prior verdict warns the naive per-city pick
  is a false positive). **Built `packages/core/src/sim/source-selector.ts`** — scores each source per city on
  the ladder-bucket MATCH, picks on TRAIN, validates OOS, overrides raw-Google only when a source beats BOTH
  raw-Google AND the blend by a margin (else shrinks to blend). **+12 tests, suite 3006 green, typecheck clean.**
  Committed. NOT DB-wired yet.
- **C3 (start, 2026-07-08):** Sized the °F universe (light SQL): **396 resolved °F markets / 11 cities**; all 3
  commercial sources cover 11 cities / ~13 forecast-days → clears §9R-E structurally (the prior investigation's
  22 was the 21-day Google-only window). Next: build the multi-source per-event feed (harness pulling
  `source_forecasts` all sources + the calibrated blend, aligned to resolved °F events) → run the selector + the
  `replayGoogleBracket` backtest → honest verdict: does source-selection beat raw-Google °F, OOS?
- **C3a (2026-07-08):** Built `scripts/research/fahrenheit-source-test.ts` — pulls the FULL resolved °F universe
  from persistent tables (`market_events`/`market_buckets`/`source_forecasts`/`bucket_probabilities`, NOT the
  pruned capture stream), scores each source's forecast center on the °F **ladder** bucket-match at lead 1, runs
  the frozen selector. **Result (decisive):** blend **84% within-1 / 38% exact** vs google 61%/26%, weatherapi
  62%, owm 52% (77-event apples-to-apples); **0/11 cities beat the blend OOS**; OOS TEST 165 ev → google 61% →
  **blend 88% within-1.** Found the bug (SourceSelEvent carries no target_date → empty split) + fixed. Typecheck
  clean, committed. **Verdict: the °F lever is a BLEND-centered cohort, not Google, not per-city commercial
  picking** — re-confirms source-accuracy-findings on the real °F bidding metric. Next (C3b): the P&L half —
  replay the blend-bucket bid at real °F market prices (cheap-band entry + hold-to-resolution) off the offline
  archive; does 88%/38% accuracy beat the market's own price? If yes → stage a blend-centered °F cohort panel.
- **C3b (2026-07-08):** Built `scripts/research/fahrenheit-source-pnl.ts` — pulls the lead-1 entry ask per
  bucket from `market_snapshots` (persistent, not the pruned stream), replays hold-to-resolution over the full
  °F universe with the real 5% taker fee + a city-clustered bootstrap 95% CI, sweeping the entry band, blend vs
  Google. Fixed a `takerFeePerShare(p,rate)` arity bug (was NaN). **Result:** blend-centered netEV/contract ~0
  everywhere (+0.06@12¢ n=6 … −0.01@50¢), **every CI straddles 0** — win% ≈ avgAsk (efficient). Google cheap
  band 0%/15 CI [−0.071,−0.038] (a real loss). **WS-A COMPLETE: no tradable °F edge — accurate but priced.**
  Typecheck clean, committed. **Pivot → WS-D** (depth-capture v2 deploy bundle + refreshed compute audit).
- **C4 (2026-07-08) — WS-D:** Measured the CURRENT compute picture (24h cron durations + failures, table sizes,
  `opening_captures` growth). **Finding: the 07-07 cull already resolved the crisis and it has held** — fleet
  healthy (0 fails/24h), DB-side load trivial, `opening_captures` bounded at 97 MB by its prune (not a runaway;
  the TOAST trap was the now-off panels). No reversible cron pause is warranted. Wrote
  **`COMPUTE-AUDIT-2026-07-08.md`** (honest refresh, not a redo) + **staged the depth-capture v2 deploy bundle**
  (the one forward win) in the operator block. Surfaced 2 optional items (drop `market_rewards` 140 MB; remove 8
  dead-signal edge fns) + 1 open Q (retire `opening-capture` post-v2). **No live change made** (correct — nothing
  safe to shed). Next: WS-B (evaluate the live Google panel numbers) / WS-C (/trading bid-logic code eval).
- **C5 (2026-07-08) — WS-A, operator-requested refined replay:** built `scripts/research/fahrenheit-blend-replay.ts`
  — the house-blend (`house_gaussian` earliest-forecast argmax) **buy 10–15¢ within 24h of live / sell at 30¢**
  play, replayed on the real per-tick book (`market_snapshots`, all °F cities, full life, no look-ahead). **42
  positions / 10 cities, avg entry 13.4¢; 42.9% win-rate; net −$32 maker / −$46 taker (ROI −7.6% / −11%)** —
  loses, narrowly (break-even 44.6%). Counterfactual: cheap buckets win only 9.5% at resolution; hold-to-
  resolution nets −$133 (−32%), so the 30¢ TP helps 4× but stays −EV. Adverse selection, efficiently priced.
  Wrote **`FAHRENHEIT-BLEND-REPLAY-RESULTS.md`** (the operator deliverable). Typecheck clean, committed.
- **C6 (2026-07-08) — WS-A, operator iteration (stop-loss + entry sweep + no time limit):** built
  `scripts/research/fahrenheit-blend-sweep.ts` — decomposed into 3 configs × 6 entry ceilings (10–15..10–20¢) on
  the real book, each lever isolated. **Findings: widening the entry HELPS (A: −7.6%→−1.1%, 57.7% win at 10–20¢);
  the stop-loss below 10¢ HURTS (~$35/band worse — cuts volatile buckets that dip below 10¢ then recover to the
  30¢ TP); removing the 24h window is CATASTROPHIC (C: −26% to −31% — late falling-knife entries, ~80% stop out).**
  Best variant = 10–20¢ / 24h / no-SL / sell-30¢ = −1.1% (still a small loss; efficient). Appended to the results
  doc; typecheck clean, committed.
- **C7 (2026-07-08) — WS-A, operator full entry x exit grid (pure flip, never hold):** built
  `scripts/research/fahrenheit-blend-grid.ts` — buy first ask in a band around E, sell (maker) at X, DUMP at last
  bid if X never fills (no resolution payout, per "not hold to finish"). Grid {5,10,15,20,25c} x {15..50c} on the
  real book, no look-ahead. **All 24 cells negative.** Best ROI buy 25c/sell 30c (71% win, -$267, -16.6%); best
  net buy 15c/sell 20c (60% win, -$261, -22.7%). Mechanism: capped flip gain vs near-$0 dumps -> needs >80%
  completion, market gives <=71%; strictly worse than holding (forfeits the $1 on the ~9.5% true winners). Grid +
  matrices appended to the results doc; typecheck clean, committed. **WS-A exhausted — no °F entry/exit is
  profitable; the market is efficient.**
- **C8 (2026-07-08) — WS-B (Google convergence play — FIRST read; was untouched C0–C7):** Light read-only probe
  (4 small SQL reads, no TOAST scans — DB healthy, not saturated) of the live `google_paper_panel`
  (`/convergence`) + its §9R-E view. **Panel HEALTHY + accruing:** 89 snapshots, `*/15` firing (latest 13 min old),
  `cityErrors` 0; universe 45 cities / 90 fresh events / 46 google-seeded / 22 no-google. **Gate =
  INSUFFICIENT_DATA** — only **5 scored markets / 5 cities / 2 dates** vs the ≥40/≥6/≥7 floor. **The headline
  +$163 / ROI +163% (winRate 3/5) is small-n NOISE, not a signal:** 83% of it is ONE held-to-resolution winner
  (mexico-city 07-05 **+$134.62**); the rest = 2 small TP wins (+$35.94 amsterdam, +$34.24 toronto @ execBid≥0.30)
  + 2 full losses (−$20.88 lucknow, −$20.88 madrid). **Ex-mexico-city: +$28 on 4 markets.** The built-in TP sweep
  already shows tp=0.30 is the best of {0.30..0.50} (higher TPs forfeit the cheap held-to-resolution winners), so
  **no tuning is justified at n=5** (would be fitting noise — rule 3/4). Config: buy 10–12¢ / TP 30¢ abs / no SL /
  ≤24h old. **Accrual ~1.7 realized/day → ~24 days to the 40-market gate.** Verdict: **the play is running
  correctly; let the forward gate arbitrate; do NOT act on the early +163%.** Docs-only cycle (no code change).
  Next-best: WS-A °C contrast grid (reuse `fahrenheit-blend-grid.ts` by unit), or design the depth-capture-v2
  parity check (both GREEN); WS-B tuning is blocked until the panel accrues.
- **C9 (2026-07-08) — WS-A °C contrast (operator follow-up #1):** Unit-parameterized `fahrenheit-blend-grid.ts`
  (`--unit F|C`; the °F run reproduces C7 byte-for-byte → faithful refactor) + added the **hold-to-resolution
  frontier** per entry band (the reference the flip must beat; `winning_bucket_idx` was already fetched). **°C
  (1045 mkts / 34 cities): the pure FLIP is dead too** — all 24 cells lose (best 25¢/30¢ 70% win −$934 −16.8%,
  ≈ °F's −16.6%; same capped-gain-vs-$0-dump mechanism). **But the HOLD-to-resolution frontier is marginally
  NON-negative at the 20¢ band: +$50 / +1.1% ROI on 447 markets** (25¢ −0.8%) — the **first non-negative hold
  across °F/°C** (°F best hold was −1.1%, C6); °C is slightly less efficient at the ~20¢ hold. **NOT AN EDGE YET:**
  a raw ungated +1.1% (+$50 on $4,470) — not clustered, not null-tested; strong prior the city-clustered CI
  straddles 0. Appended to `FAHRENHEIT-BLEND-REPLAY-RESULTS.md`; **suite 3006 green, typecheck clean, committed
  (cdebff7)**. Light DB (per-bucket `market_snapshots` reads, no TOAST). **▶ C10 = run the °C 20¢-hold band through
  the §9R-E gate** (`openingVerdict`: city-clustered ciLow>0 + zero-skill sign-flip MC<5%) — only a clustered
  ciLow>0 promotes it, else it joins the efficient graveyard. (Nice reuse: this is exactly what the new
  `betting-market-analytics` skill / `analytics.py gate` was built to adjudicate.)
- **C10 (2026-07-08) — WS-A gate the °C 20¢-hold lead → KILL; WS-A now FULLY EXHAUSTED:** Built
  `scripts/research/hold-band-gate.ts` — builds one hold-to-resolution `OpeningMarketResult` per market in a band
  and runs the TS source-of-truth `openingVerdict` (city-clustered CI + zero-skill sign-flip MC + day-block
  tightening). **°C 20¢ band (447 mkts / 34 cities / 26 days): VERDICT = KILL.** The C9 **+1.11% raw ROI was a
  dollar-weighting mirage** — collapse to one mean per city (the independent unit; same-day weather correlates)
  and the honest **city-clustered mean is −4.13%**, 95% CI [−26.5%, +18.3%] straddles 0; zero-skill MC 1.9%,
  day-clustered CI [−25.0%, +50.6%]. (winFrac 21% is expected for a buy-cheap-HOLD longshot, so `ciLow>0` is the
  binding criterion — decisively failed.) **No 13th signal; the market prices the house-blend's cheap buckets
  correctly in both units.** Appended to `FAHRENHEIT-BLEND-REPLAY-RESULTS.md §C10`; **suite 3006 green, typecheck
  clean, committed (55a8f47)**. Light DB (per-bucket best_ask reads). **▶ C11 = depth-capture-v2 parity-check
  design (WS-B∩WS-D, GREEN) or WS-C /trading bid-logic code eval** — WS-A is closed, WS-B tuning blocked on accrual.
- **C11 (2026-07-08) — OPERATOR-DIRECTED: the NO-FADE (negative convergence play) across all cities → KILL:** Built
  `scripts/research/no-fade.ts` — buy NO 50–70¢ (== YES best_bid 30–50¢) on ±3-neighborhood buckets, flip-sell
  (maker) at ≥80¢ else dump; HOLD-to-resolution reference; per-market portfolios through the city-clustered
  `openingVerdict`. **1077 mkts / 45 cities / 26 days, 2766 NO positions. Every variant KILLs with an ENTIRELY-
  negative CI:** FLIP all ±3 −21.9% [−24.0,−19.8], FLIP neighbors −20.5%, HOLD all −6.6% [−8.4,−4.7], HOLD
  neighbors −5.9% [−9.3,−2.5] (zsMC 2.7–3.2%). **Mechanism:** adverse selection (NO 50–70¢ self-selects the buckets
  most likely to actually WIN — entered NO-win only 61–67%, not ~90%) + the flip caps upside/keeps downside (C7
  redux); even hold loses ~6% (efficient YES ⇒ efficient NO net of taker fee + adverse selection). Caveat:
  top-of-book only → true depth makes it worse. **The NO side mirrors the dead YES convergence play and dies the
  same way — no 13th signal.** Deliverable `NO-FADE-RESULTS.md`; **suite 3006 green, typecheck clean, committed
  (dd4eb98)**. DB: one chunky 530k-row internal join, returned fine (sized first, no strain). **▶ C12 =
  depth-capture-v2 parity-check design (WS-B∩WS-D) or WS-C /trading bid-logic eval.**
- **C12 (2026-07-08) — OPERATOR-DIRECTED: NO-fade buy×sell GRID → every cell KILLs, no profitable combination:**
  Built `scripts/research/no-fade-grid.ts` — swept the full NO entry-band (35–85¢) × exit-target (70–95¢) surface +
  the HOLD reference, gating each cell through the city-clustered `openingVerdict`. **478,640 ticks / 1,084 mkts /
  45 cities. ALL ~27 cells KILL; ZERO have ciLow>0.** Best = **buy NO 85¢ / HOLD = −4.8% [−6.0%, −3.6%]** (still
  KILL). Two monotone patterns: (a) **HOLD always beats FLIP** (flip caps upside + dumps losers = C7 mechanics,
  universal on NO); (b) **buying NO EXPENSIVE is least-bad** (fee-only fair bet on a near-certain no) while buying
  NO CHEAP fades favorites (−14% to −47%). Market efficient across the ENTIRE NO surface. Appended `NO-FADE-RESULTS.md`
  §grid; **suite 3006 green, typecheck clean, committed (f0e230b)**. DB note: the MCP sizing query hit the Micro's
  **8s statement timeout** (heavy window fn) → did the 478k pull via the direct tsx conn (one plain join, no strain);
  avoid DB-side window/distinct aggregations on the Micro via MCP. **▶ C13 = depth-capture-v2 parity-check design
  (WS-B∩WS-D, GREEN) or WS-C /trading bid-logic eval** — WS-A + the NO-fade surface are both fully exhausted.
- **C13 (2026-07-08) — WS-C: /trading bid-logic eval (`order-intent.ts`) — SOUND + one hardening:** Evaluated the
  pure per-market bid core (rail stays DORMANT — code-eval only). **The maker never-cross guarantee
  (`makerLimitPrice`, snap-to-grid + strictly-inside-book + reject) + `orderIntentKey` idempotency +
  `resolveTradeMode` fail-safe-to-dry-run + the fail-loud CLOB parsers are all CORRECT and thoroughly tested**
  (~59 tests: at-ask/bid, 1-tick floors, fine/coarse grids, fp drift). Found + fixed ONE asymmetry:
  `takerLimitPrice` did NOT clamp to `[tick,1−tick]` (unlike makerLimitPrice) → a near-boundary worst-price
  gridUp→1.0 / gridDown→0 (off-grid, venue-rejected). Latent today (entries cap 20%, stops sit inside) but hardened
  by construction +5 boundary tests. **suite 3007 green, typecheck clean, committed (ec762c6)**. **▶ C14 = continue
  WS-C (`live.ts` MakerExecutor place/reprice/reconcile + `planPlacements`) OR depth-capture-v2 parity-check design.**
- **C14 (2026-07-08) — WS-B∩WS-D: depth-capture-v2 CROSS-PATH parity check (the deploy's load-bearing de-risk):**
  The handoff makes the parity check a POST-deploy step (§6.3) — but the "does `market_depth` reproduce the panel
  vs `opening_captures`" question is answerable OFFLINE. Built `supabase/tests/google-repoint-parity.test.ts`: seed
  ONE shared fresh °C event into BOTH sources with an IDENTICAL ladder + exec trajectory, run both RPCs
  (`google_paper_inputs` depth path, threshold forced; `google_paper_inputs_opening` fallback), feed each through
  `buildGoogleView`, assert the panel DECISION is byte-identical — entry bucket, taker fill, take-profit exit, P&L,
  money tracker, §9R-E gate counts/verdict, the 5-TP variant grid, coverage counts. **Non-vacuous:** a guard test
  proves BOTH sources were truly exercised (depth nulls peakMid/isFlatOpen/houseSeeded; opening carries the stored
  0.5/true) — not the fallback twice; both fire exactly 1 realized take-profit. **Correctly SCOPED:** isolates the
  shape/anchor/complete-ladder parity (what a pre-deploy test CAN prove) from the DOCUMENTED population difference
  (depth's fresh cohort is smaller by discover cadence — that's a live-forward property, not a regression). Catches
  any SQL key-name/anchor/ladder regression in the rewritten `0088` before the operator applies it. **suite 3014
  green (+7), typecheck clean, committed (d0898b0)**. No DB touch (pure PGlite). **▶ C15 = WS-C (`live.ts`
  MakerExecutor + `planPlacements` code-eval) — the last GREEN buying-build thread; WS-A exhausted, WS-B tuning
  blocked on accrual, WS-D lean (07-07 cull holding), depth-v2 now parity-proven + staged for the operator.**
- **C15 (2026-07-08) — WS-C: MakerExecutor place/reprice/reconcile/cancel code-eval — SOUND + 3 money-path guard
  tests added:** read the whole `MakerExecutor` (`live.ts:455–1041`). The crash-safety + raced-fill + idempotency +
  redaction story is **coherent and comprehensively tested (60 cases)** — every reprice raced-full/partial/below-min/
  still-live/size-mismatch branch, reconcile adopt/ambiguous/freed/taker-hit/maker-falsifier/evidence-fail, cancel
  raced-partial/full/poll-throw/ledger-raise, place HIGH-A(a,b,c)/CRITICAL-1/T3-final/shapeless. No bug found (this
  was already a 3-round-reviewed T1 lane). Closed **three genuine coverage gaps** on the live money path, each a
  DISTINCT return statement that could silently drift: (1) `placeTaker` open-intent idempotency — a resting
  stop-loss/time-stop is NEVER re-fired on crash-restart/retry (the **double-SELL guard**; was tested for `place()`,
  not `placeTaker`); (2) `placeTaker` concurrent-reserve race → duplicate, no post; (3) `cancel()`'s standalone
  not-allCanceled early-out — returns UNPOLLED, no ledger transition, key stays held (was only exercised inside
  `reprice()`). Tests-only, no behavior change. **suite 3017 green (+3), typecheck clean, committed (a56d864)**.
  **▶ C16 = the loop has now swept every GREEN buying-build thread** (WS-A exhausted; WS-B parity-proven + accrual-
  blocked; WS-C order-intent[C13] + MakerExecutor[C15] both SOUND; WS-D lean + holding). Remaining forward motion is
  operator-gated (deploy the staged depth-v2 bundle) or accrual-gated (the §9R-E gates need forward days). Next best
  = a light periodic re-verify of the live fleet/gate health + `/convergence` accrual, else idle at low cadence.
- **C16 (2026-07-08) — WS-D: LIVE-INCIDENT found via a health probe + fixed-in-code (migration `0090`):** the
  session's protocol-step-1 live re-verify (4 light stat reads, no TOAST scans) surfaced a **real degradation the
  code-only C14/C15 cycles couldn't see**: `job_runs` = **~53 fails/24h, STEADY ~3–4/hr ALL hours** (C4's 14Z read
  missed it) — **health-monitor `data_freshness` ~80% + poll-markets `upsert_market_snapshots` ~5%**, both
  `statement timeout`. **Diagnosed OFFLINE** (stopped DB work after the read, rule 2): `data_freshness` (0020) does
  `max(captured_at)` over `market_snapshots` (346 MB) + `forecast_snapshots`, **neither captured_at-indexed** →
  full seq scan every */30 tick (no loose index scan over the bucket_id-/icao-leading composites) + contends with
  poll-markets' upserts on the same table. **Wrote `0090_freshness_indexes.sql`** (two `captured_at desc` indexes →
  `max()` = instant index fetch + sheds the scan load) + a migrations.test.ts index assertion. **suite 3018 green
  (+1), typecheck clean, committed (d7342dd)**. **PROD is money-path-gated + STAGED** (build CONCURRENTLY off-peak
  FIRST, then apply — a plain CREATE INDEX would lock the hot `market_snapshots`; full sequence + rollback in the
  operator block). Additive; money path untouched. **▶ C17 = confirm the operator ran 0090's index build (fails
  drop to ~0), else all GREEN threads swept → low-cadence fleet/gate/accrual watch.**
- **C17 (2026-07-08 ~20:45Z) — OPERATOR-DIRECTED: applied migration `0090` (the C16 fix) — incident RESOLVED.**
  Operator said "apply 0090" → applied it the money-path-safe way (NOT a naive locking `apply_migration`): pre-check
  (no existing/invalid indexes; ms 348 MB / fs 279 MB; 0090 unrecorded) → built `forecast_snapshots_captured_idx`
  **CONCURRENTLY** (canary, lock-free) → built `market_snapshots_captured_idx` **CONCURRENTLY** → verified both
  `indisvalid` → **`explain` proved the fix** (`max(captured_at)` on market_snapshots = `Index Only Scan …
  Heap Fetches: 1`, was a 964k-row seq scan) → recorded migration `0090` via `apply_migration` (the `if not exists`
  no-op'd since the indexes existed). poll-markets clean `ok` through the build (lock-free confirmed); health-monitor's
  next */30 tick (~21:00Z) is the first post-fix run. **This is the loop's FIRST RED action — done under EXPLICIT
  operator authorization** (the boundary holds: Claude never trades/keys/live-rail, and applies migrations only when
  the operator directs it). Rollback = drop both indexes. **▶ C18 = confirm the sustained failure drop at the ~21:00Z
  health-monitor tick (the 1h wakeup lands after it), then resume low-cadence watch — all GREEN build threads swept.**
- **C18 (2026-07-08 ~21:23Z) — CONFIRMED the 0090 fix landed; incident CLOSED.** Light job_runs read: since the
  20:44Z index build, **health-monitor's 21:00Z */30 tick ran `ok`** (the first post-fix run — was ~80% failing) and
  **poll-markets is 8/8 `ok`** (20:45→21:20 */5). Zero failures on either job since the fix → the C16 statement-timeout
  incident is fully resolved, EXPLAIN proof now backed by live ticks. Docs-only. **▶ ALL threads settled: WS-A
  exhausted, WS-B parity-proven + accrual-blocked, WS-C sound (C13+C15), WS-D lean + the timeout incident CLOSED
  (0090 live). Remaining motion is operator-gated (depth-v2 deploy — non-urgent) or §9R-E-accrual-gated (~24 days).
  → LOW-CADENCE idle watch: periodic light fleet/gate/`/convergence` re-verify; no build work pending.**
- **C19 (2026-07-09) — OPERATOR-DIRECTED analysis (via `betting-market-analytics` skill): winning-bucket price
  trajectories over ALL saved data → market CALIBRATED, "buy-the-dip" is survivorship (no edge).** Scanned the full
  **238.3M-obs** enriched price archive (offline parquet — ZERO DB load) → 6,146 winning buckets / 45 cities. Logged
  per winner: low point, time-from-start of the low, fluctuation count, drawdown (`winning-bucket-lows.csv`).
  **Descriptive patterns:** winners bottom at a **12.5¢ median low, ~15% into life** (~10h; bimodal — open-is-the-low
  vs a late-dip tail), swing **~8×** (≥5¢) before converging to $1; 90% dip <30¢; °C/°F alike; only 33% of winners were
  our predicted bucket (the ones we missed were the cheapest). **Decisive cross-check (the honest part):** point-in-time
  calibration (`price-calibration.csv`) shows the series is calibrated with a **consistently NEGATIVE gap** in the
  5–55¢ band (a bucket at 13.5¢ wins 10.8%, at 22.5¢ wins 20.0% — you win 2–5¢ LESS than you pay, frictionless). The
  Pass-B "88% win if lifetime-min ∈ 5–30¢" is pure look-ahead; at the dip the future winner is indistinguishable from
  the future loser. Re-confirms efficiency (§12 cheap-longshot + dead convergence) from a new angle. FINDINGS.md row
  added; verdict `scripts/research/out/winning-bucket-analysis.md`. No code change (analysis + docs). **▶ C20 = resume
  low-cadence idle watch — nothing actionable pending (operator-deploy / accrual gated).**
- **C20 (2026-07-09) — OPERATOR-DIRECTED analysis expansion: winner ±2 neighborhood + forecast-anchored
  realizability test → KILL (the +EV is hindsight, realizable = −1.4%/fee).** Two offline passes on the 238M archive
  (zero DB load). **Neighborhood spread:** winner buys ~12.5¢ / passes ~88.5¢ before an endgame starting at ~83% of
  life; colder neighbor (rp−1) strongest competitor (high p90 0.84). WITHIN the true winner-centered ±2 the gap turns
  **+1–3%** (buy 5–40¢) — but that is hindsight. **The operator's theory** (our ±1° 88% accuracy ≈ knowing the winner)
  **tested decisively:** re-anchored the ±2 neighborhood on `pred_bucket_l1`; forecast-±2 contains the winner **90.6%**
  (±1 74%, exact 33%) yet the buy-band [5–40¢] hold EV **collapses from +2.14%/+1.09%-fee (hindsight) to −0.37%/−1.42%-fee
  (realizable)** — inside the neighborhood price≈win-prob because the market already priced our forecast in. Confirms
  why the forecast-centered convergence/maker-exit died, with a number. Docs `neighborhood-analysis.md` +
  `forecast-anchored-*.csv`; FINDINGS.md rows added. No code change. **Open non-price lever the operator flagged:** a
  winner FINGERPRINT from momentum/hold-time/order-flow (not price) — the one angle the efficiency prior doesn't already
  settle. Future: weather-regime error-attribution (front/cloud/precip vs model miss) — needs an added regime source
  (METAR present-weather + reanalysis), parked. **▶ C21 = low-cadence idle watch; nothing actionable pending.**
- **C21 (2026-07-09) — OPERATOR-DIRECTED analysis: the peak→dip→recover round-trip scalp → KILL (a martingale
  scalp priced by the level).** The path-structure sibling of C19, and the **FIRST forward-executable form** of the
  winner-dip family: buy any bucket that ALREADY traded ≥25¢ and has NOW dipped to 10–15¢ (both observable AT ENTRY —
  not C19's lifetime-min hindsight), sell on recovery to ≥25¢, else hold to resolution. New engine
  `scripts/research/winner-roundtrip-scalp.ts` (+ `.test.ts`, **14 green**; reuses `winner-band-prices.ts` loading +
  the committed `synthBook`/`CALIBRATED_BOOK` cost model + `takerFeePerShare`) over the 46-city `market-history`
  archive → **23,105 round-trips / 45 cities / 523 days** (zero DB load). **Part A — curvature by offset:** the
  peak→dip→recover shape IS strongly offset-dependent — recovery rate winner **99.8%** → ±1 63% → ±2 44% → far(≥3)
  34% — BUT the winner's ~100% is **TAUTOLOGICAL** (a winner that dips to 12¢ must cross 25¢ en route to $1) and
  unusable: at the 12¢ entry moment a winner-dip is indistinguishable from a far-bucket-dip. **Part B — the trade:**
  median entry 14¢, empirical hit-rate **54.5%** sits AT/below the **martingale null 56.0%** (=entry/sell) — the
  recovery is not mean-reversion, it's the level being right. Asymmetric payoff (win small-capped 25¢ vs lose the
  FULL stake on dip→0) ⇒ **winFrac 54.5% > 0.5 but EV NEGATIVE** — a naive win-rate test false-passes; the return-CI
  kills it. §9R-E gate (city+day clustered): frictionless +0.89% CI **[−1.31%,+3.09%]** (wash, includes 0);
  maker-exit ceiling −14.82%; **taker ×1 −21.48% CI [−23.16%,−19.80%]**; breakeven spread NEVER positive (fee-only
  −6.2%). Verdict `scripts/research/out/WINNER-ROUNDTRIP-ANALYSIS.md`; FINDINGS.md row + memory added. Re-confirms
  efficiency from the path-structure angle; no new edge; all 12 signals stay dead. **▶ C22 = low-cadence idle watch;
  nothing actionable pending (the non-price winner-fingerprint lever from C20 remains the only open direction).**
- **C22 (2026-07-09) — OPERATOR-DIRECTED: the NON-PRICE winner-fingerprint hunt → NO edge; closes the last open
  direction from C20/C21.** Operator: "find a net positive edge in buying/selling — evaluate all options
  systematically." Framed as the **sufficient-statistic test** (a non-price feature has an edge iff
  `E[won|price,feature] ≠ E[won|price]` beyond cost). Built the instant feature panel
  (`nonprice-fingerprint-panel.ts`, 652,257 instants / 6,273 events / 45 cities / 523 days, 10 features) + the
  conditional test (`nonprice_conditional.py`) + the real-book decider (`realbook-fade.ts`) — all tested, +
  a **parallel agent** on the order BOOK. **THREE convergent findings:** **(1)** price is a sufficient statistic —
  every path feature's price-controlled lift is a trivial ±0.3–1.9pp and **every group's frictionless EV (won−p)
  is NEGATIVE** (momentum micro-structure is real but priced in; best BUY cohort gates −34%). **(2)** the only
  cohort that gated positive on the mid — fading the most-overpriced "unmoved cheap" buckets (bottom run-up
  decile, = the known §12/C19 overpricing) — passed EVERYTHING on the mid (spread ×2, OOS +1.81%, city+day
  clustered, zsMC) then **FLIPPED +3.39%→−9.75%** priced off the REAL bid/ask on the same 3,073 opening_captures
  events (median executable bid-side depth **$2**, p10 $0 = stale one-sided mid) — flagship trap #1+#8, exactly
  the maker-exit story. **(3)** the agent's independent order-BOOK test (imbalance/spread/depth): none carries
  residual info beyond mid (all straddle 0); baseline cheap-buy KILLs −80.3%; only `house_gap`=the dead forecast
  signal survives residual-info and its trade loses. Docs `NONPRICE-FINGERPRINT-THESIS.md` + `ORDERFLOW-FINGERPRINT.md`;
  FINDINGS.md row + memory added; new engines + tests committed (suite green, typecheck clean). Market efficient
  on price, path-shape, AND order flow; no non-price fingerprint exists. **▶ C23 = low-cadence idle watch; the
  price-side edge space is now exhaustively closed — no open lever remains.**
