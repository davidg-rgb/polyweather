# Maker-Exit Forward Paper Loop — Build Handoff

> **Goal.** Stand up the **forward, paper-only maker-exit loop** that replays the tuned maker-exit convergence
> strategy against the **live order book** (the `opening_captures` capture stream) and **measures the three
> assumptions** the 708-event backtest could not resolve — turning the `MAKER-EXIT-SIM.md` result (positive-EV,
> §9R-E KILL on ciLow) into a **real forward verdict on real-book depth + real fills + the real rebate tier**.
> No capital, ever, until a frozen paper PASS. Claude builds the software; the **operator** funds + holds the
> signing key; Claude never places a trade or touches credentials.

Status: **BUILT (2026-06-30) — tested, operator-deploy-gated.** The forward loop is built as the maker-exit twin
of `convergence-panel` (the perf-proven re-replay-over-accumulated-captures design, NOT a fragile per-tick state
machine — see §0b): it reuses the live capture stream + the tested `replayMakerExitPanel` engine wholesale and
persists the §9R-E verdict to `bot_gate_snapshot` (the gate the deadman already watches). Full suite **1772
green**, typecheck clean. The decision core, the capture layer (`opening-capture`, LIVE), and the gate all
pre-existed; this loop is the thin shell + the measurement columns + the dashboard over them.

---

## 0a. BUILT — what shipped + the operator deploy steps (read first)

**Shipped (committed, not deployed):**
- **Pure core (tested):** `core/sim/opening-maker-exit-replay.ts` — `MakerExitTrade` extended with the measurement
  diagnostics (`bucketIdx`, `entryTickIndex`/`exitTickIndex`, `makerFillLatencyTicks`, `observedEntrySpread`/
  `observedExitSpread`, `rebateRateUsed`) computed in `replayMakerExitEvent`; `MAKER_EXIT_TUNED` + `makerExitCfg()`
  pin the §5 params in CODE (so the loop never mutates the shared `bot.*` config). `core/sim/opening-maker-exit-view.ts`
  — `buildMakerExitView` (the maker-exit twin of `buildConvergenceView`): entries + the THREE measured assumptions +
  the fictive money tracker + the §9R-E gate, reusing `buildEvents` + `replayMakerExitPanel`. +28 tests.
- **Migration `0073_maker_exit_paper_loop.sql`:** `bestBid` added to `convergence_capture_inputs` (the spread
  diagnostic reads it); `maker_exit_panel` snapshot table + `record_maker_exit_panel`; additive maker-exit
  aggregate columns on `bot_gate_snapshot` + `record_bot_gate_snapshot`; `record_bot_tick`; `dash_maker_exit`
  (operator read); cadence-aware `bot_deadman_check` (`bot.tickStaleMin`) so the 15-min loop's tick log doesn't
  false-alarm; the `maker-exit-panel` cron (*/15). +5 pglite-twin tests.
- **Edge fn `supabase/functions/maker-exit-panel/`** (`index` + `handler`) — pages the fresh-allowlist captures
  per city, runs `buildMakerExitView`, writes the snapshot + the forward gate snapshot + a tick. Registered in
  `config.toml` (`verify_jwt = false`).
- **Dashboard `/maker-exit`** — page + `getMakerExit` loader + nav entry, headlining the three measured assumptions.

**Operator deploy steps (the boundary §6 stays intact — paper-only, no key, no capital):**
1. Apply migration 0073: `npx --no-install supabase db push --use-api --project-ref lenysiqxihsmxljvyybt` (or via
   the Supabase MCP `apply_migration`). Adds the snapshot table/RPCs/cron + the deadman update. Idempotent.
2. Deploy the edge fn: `npx --no-install supabase functions deploy maker-exit-panel --use-api --project-ref lenysiqxihsmxljvyybt`.
   The `*/15` cron (added by 0073) then drives it; until deploy the cron POST 404s harmlessly.
3. Vercel auto-rebuilds on push → `/maker-exit` goes live (degrades to a "deploying" message until the first tick).
4. Let it accrue ≥7 distinct target days / ≥40 markets (~1–3 weeks), then read `/maker-exit` (or `dash_maker_exit`)
   for the forward §9R-E verdict. **PASS + an explicit operator GO → the separate small-real step; else KILL →
   FINDINGS.md, rail DORMANT.** No capital before a frozen paper PASS.

## 0b. Design note — why re-replay, not a per-tick state machine

The literal handoff §3 reads as a stateful per-tick position manager, but `replayMakerExitEvent` replays an
event's WHOLE accumulated tick series at once and returns a completed trade — so the faithful, lower-risk build is
the **re-replay design**: `opening-capture` already accumulates the full forward two-sided book; each 15-min tick
re-runs the tested `replayMakerExitPanel` over the (downsampled) fresh-allowlist captures and persists. This
measures all three assumptions IDENTICALLY (the captures are the real forward book; the fill model is the same
pure function; days accrue as captures grow) **without** prematurely building the live-execution state machine
(correctly deferred to the post-PASS live step per §6). It also dodges the exact bug class that bit the
bracket-exit replay (an impure stateful shell hauling the whole series). The gate is computed over the persisted
forward panel; the replay window stays bounded (still-open events close within ~1–2 days given the 18h time-stop).

---

## 0. TL;DR for next session (read first)

1. **Don't rebuild the spine — reuse it.** The capture stream, the bot tables, the pure decision functions, and
   the §9R-E gate already exist. This loop is a thin, stateless tick over them with the **maker-exit lifecycle**.
2. **The whole point is the measurement.** The backtest assumed: (a) a maker fill model, (b) a 0.05 rebate, (c)
   17 days. The loop must **measure all three for real** — that is its only reason to exist. Build the measurement
   columns first; the P&L falls out of them.
3. **Paper-only, hard-gated.** `mode='paper'` everywhere; the §9R-E gate (`openingVerdict`) adjudicates; the rail
   does not advance to live without a frozen paper PASS **and** an explicit operator decision.
4. **Boundary (non-negotiable, §8 of the convergence handoff):** Claude builds; the operator funds the dedicated
   wallet, holds `POLY_PRIVATE_KEY` (`.env.local`, never in chat), authorizes runs. Claude never trades, never
   handles credentials, never surfaces the key.

---

## 1. Why now

`MAKER-EXIT-SIM.md` (2026-06-30) found the maker exit **flips the convergence edge positive** — the same strategy
nets **+1.8 % (no rebate) / +5.1 % / +$313 (measured rebate)** vs the taker exit's **−3.0 %** — the first
positive-EV configuration across all twelve signals. But the §9R-E gate **KILLs** it: over only **17 days** the
city-clustered 95 % CI is **[−1.6 %, +11.5 %]** (lower bound just below 0; winFrac 58.8 % and the zero-skill MC
both clear). It is positive in expectation but **not yet statistically clear of zero**, and it rests on **three
assumptions a backtest cannot resolve**:

| # | assumption (backtest) | how the live loop resolves it |
|---|---|---|
| 1 | a resting maker SELL fills when a later **bid reaches the limit** | observe, per position, whether the live book actually traded **through** the resting limit in a later capture tick (the real fill rate, queue + adverse selection §12 included) |
| 2 | maker **rebate = 0.05** (the measured weather *magnitude*) | read the **real** maker rebate from the venue fee schedule per market (`market_buckets.fee_rate` / the gamma fee parse already wired by REC-3), tier-accurate |
| 3 | **17-day** temporal extent (wide day-clustered CI) | accumulate **real days forward** until the §9R-E day floor + a tight CI — the CI narrows as days grow; if the +5.1 % mean holds, `ciLow` crosses 0 and the gate flips |

When all three are measured and the §9R-E gate renders a verdict on the **forward** panel, the maker-exit thesis
gets its honest answer — the same discipline that closed the other eleven signals.

---

## 2. What already exists (reuse — do NOT rebuild)

- **Capture layer (Phase 0, LIVE on prod):** `supabase/functions/opening-capture` → writes `opening_captures`
  (per-tick two-sided book: `mid / bestAsk / execAsk / depthUsd / bestBid / execBid / sellbackDepthUsd /
  houseProb`, by event, the §9R cities). This IS the live book the loop reads — **no new fetcher needed**.
- **Bot tables (migration 0066, 0 rows):** `bot_positions` (the state of record — `mode`, `event_id`, `city`,
  `target_date`, `tz_name`, …), `bot_orders`, `bot_loop_lease`, `bot_gate_snapshot`, `bot_tick_log`,
  `bot_bankroll`, `bot_daily_kill`, `bot_circuit_state`. **Ready — wire the loop to them.**
- **Pure decision core (one source of truth, byte-identical to the backtest):**
  - `core/sim/opening-convergence.ts` — `selectEntries` (entry), `bracketDecision` (the taker SL/time-stop logic),
    `paperFill` (the maker/taker fill model), `openingVerdict` (the §9R-E gate), `BotConfig` / `parseBotConfig`.
  - `core/sim/opening-bracket-replay.ts` — `enterAndFill` (the SHARED entry leg).
  - `core/sim/opening-maker-exit-replay.ts` — **the maker-exit lifecycle** (`replayMakerExitEvent`): the exact
    decisions the live loop must take, already pure + tested + no-look-ahead. The loop is a thin impure shell that
    feeds it LIVE captures instead of the synth book.
- **The gate:** `openingVerdict` + `MAKER_EXIT_DEFAULTS` + the tuned params (below).
- **The boundary + the safety machine:** `ARCHITECTURE-OPENING-CONVERGENCE.md` §J (kill switch, lease, circuit
  breaker, daily-loss latch, dry-run default) — all designed; honor them.

---

## 3. The build — the forward maker-exit paper loop

A **stateless, self-chaining tick** (~30–60 s; or piggyback the existing capture cron) over the live captures.
Per tick (mirrors `ARCHITECTURE-OPENING-CONVERGENCE.md` §J: tick → kill-check → scan → place → manage → settle):

1. **Lease + kill-check.** Acquire `bot_loop_lease` (no overlapping ticks); abort if `bot_enabled='0'` or a
   circuit/daily-kill latch is set. (Reuse the designed machine.)
2. **Entry (unchanged from the backtest spec).** For fresh §9R events with no open paper position, run
   `selectEntries(..., { requireFlatOpen:false })` at the **tuned cell** (chw 0 / maxEntry 0.30 / depth $150 /
   the edge + 20 %-cap gates) and rest a **maker BUY** at `makerLimit` → write a `bot_orders` row +
   a `bot_positions` row (`mode='paper'`, `state='maker_resting'`). **One position per event** (the partial-unique
   open-position constraint, W2).
3. **Fill resolution against the LIVE book (the measurement, entry leg).** On later capture ticks, the resting
   maker BUY is **filled in paper** iff the live `execAsk ≤ makerLimit` traded **through** it within
   `makerFillWindowMin` (the tuned **30 min**); else cancel + taker fallback. **Record the realized fill price +
   whether it was maker or taker + the observed spread** (this measures assumption #1 on the entry leg).
4. **Maker-exit lifecycle (the new part).** For a filled position, each tick:
   - **Maker take-profit:** a resting SELL at `entry + tpDeltaPp` (tuned **0.12**) is **filled in paper** iff a
     later capture tick shows the live `execBid ≥` the limit (a buyer lifted the offer — the symmetric mirror of
     the entry rule, adverse-selection-aware). Fill **at the limit**, **$0 taker fee + the real rebate** (read
     per-market — assumption #2). Record `is_maker_exit=true` + the observed fill latency.
   - **Taker stop-loss:** `execBid ≤` the F13 ternary stop → flatten taker (pay the real fee). You cannot rest
     above a falling market (§12) — this is the adverse-selection cost, measured.
   - **Taker time-stop:** at **resolvesAt − `tstopHoursBeforeResolve`** (tuned **18 h**) flatten taker at the
     live bid. (NOT the local-noon clock — the operator's "exit … or at the latest N hours from bet closing.")
   - All three decisions ARE `replayMakerExitEvent`'s logic — **call the pure function** with the live tick; do
     not re-implement.
5. **Settle + persist.** On exit/resolution write the realized leg to `bot_orders` + close `bot_positions`; log
   the tick to `bot_tick_log`. Update `bot_bankroll` (paper).
6. **Gate snapshot.** Periodically run `openingVerdict` over the **closed paper positions** → write
   `bot_gate_snapshot` (the running forward verdict + the three measured assumptions). This is what the operator
   reads to decide.

**The measurement columns (build these first — they are the deliverable):** per closed position record
`entry_is_maker`, `exit_is_maker`, `observed_entry_spread`, `observed_exit_spread`, `maker_fill_latency_ticks`,
`rebate_rate_used` (the real per-market tier), `exit_kind`. The forward verdict + these three aggregates
(**maker-fill rate**, **realized rebate**, **days accumulated**) ARE the answer to the three assumptions.

---

## 4. The frozen gate — the DoD for a paper PASS (do not weaken)

Reuse `openingVerdict` exactly (`GATE_MIN_MARKETS 40 / GATE_MIN_CITIES 6 / GATE_MIN_DISTINCT_DAYS 7 /
GATE_MIN_WIN_FRAC 0.5 / ciLow > 0 / zeroSkillPassRate < 0.05`). A paper **PASS** requires, on **closed forward
paper positions**: ≥ 40 markets · ≥ 6 cities · ≥ 7 distinct days · winFrac ≥ 0.5 · **city-clustered ciLow > 0** ·
zero-skill MC < 5 %. The backtest's lone miss was **ciLow ≤ 0** — so the forward run's job is to show `ciLow > 0`
holds as days accumulate and the real fill/rebate replace the assumptions. **No capital before this PASS + an
explicit operator decision** (then the first-N live fills are post-fill reviewed — `ARCHITECTURE` §first-N).

---

## 5. The tuned starting params (re-validate forward — the sweep was in-sample)

`tpDeltaPp 0.12 · slDeltaPp 0.20 · tstopHoursBeforeResolve 18 · centerHalfWidth 0 · maxEntryPrice 0.30 ·
depthFloorUsd 150 · makerFillWindowMin 30 · consensusSource calibrated (house_gaussian — it out-selected
ensemble_raw 73.9 % vs 52.8 %, CONVERGENCE-TUNING Finding 2)`. Seed them into the `config` table as `bot.*`
overrides; the §9R-E gate may only TIGHTEN. **The forward run re-validates them** — an in-sample optimum is not a
forward truth (the OOS discipline still applies).

---

## 6. Boundary (NON-NEGOTIABLE)

Claude builds the software and the analytics. The **operator** funds the dedicated wallet, holds the signing key
(`POLY_PRIVATE_KEY` in `.env.local`, **never in chat**), and authorizes any run. Claude **never** places a trade,
**never** enters or handles credentials, **never** surfaces the key. The loop defaults to **dry-run / paper**; an
**instant manual kill** (`bot_enabled` flag) is checked **every tick**; a full audit ledger (`bot_orders` +
`bot_tick_log`) records everything. Going live is a separate, operator-gated step **after** the paper PASS.

---

## 7. Phases + DoD

| Phase | What | DoD |
|---|---|---|
| **P1 · schema** | add the measurement columns to `bot_positions`/`bot_orders` (entry/exit maker flags, observed spreads, fill latency, rebate tier) + a `dash`/RPC for the forward gate snapshot | migration applied (operator-gated); columns nullable, additive |
| **P2 · loop** | the stateless tick edge fn (`opening-maker-exit-loop` or extend `opening-capture`) calling `replayMakerExitEvent` against live captures; lease + kill-check + circuit breaker reused | unit-tested pure shell; a dry-run tick writes a paper position end-to-end on a fixture |
| **P3 · measurement** | wire the three aggregates (maker-fill rate, realized rebate, day count) into `bot_gate_snapshot` + a small `/maker-exit` dashboard panel | the snapshot shows the running forward verdict + the 3 measured assumptions |
| **P4 · forward run** | deploy paper-only; accumulate closed positions | the §9R-E gate renders PASS / KILL on ≥ 40 forward markets / ≥ 7 days |
| **P5 · decision** | operator reads the gate snapshot | PASS + operator GO → the (separate) small-real step; else KILL → FINDINGS.md, rail DORMANT |

DoD for the whole build: a **paper PASS or KILL on real-book forward data**, with the three assumptions measured,
no capital moved, the boundary intact.

---

## 8. Open questions / risks to watch

- **§12 adverse selection (the load-bearing risk).** The maker exit only fills on favorable moves; the live fill
  rate could be **lower** than the backtest's "bid reaches limit" model (worse) — or the captured spread higher
  (better). The maker-fill-rate measurement (assumption #1) is exactly this; if the real rate craters, the edge
  dies. This is the single most likely way the forward run KILLs.
- **Queue position.** The capture stream sees the book, not our queue priority. The paper fill model
  (through-the-limit) is a reasonable proxy but optimistic on a thick level; note it and prefer the conservative
  reading when the forward read is marginal.
- **Rebate tier reality.** Confirm the per-market maker rebate is actually paid on weather markets at the tier the
  fee schedule advertises (REC-3/REC-4 wired the ingest; cross-check the realized rebate vs the advertised tier).
- **Capture cadence vs the maker window.** The live capture tick (~30 s) is far finer than the backtest's 20-min
  cadence, so the maker-fill chances are richer forward — good for the entry leg, but re-confirm `makerFillWindowMin`
  (30 in the backtest was a cadence artifact; forward the bot's real 15-min may suffice — measure it).
- **Day accrual rate.** ~6–10 §9R cities/day → ~7 distinct days reaches the gate floor in ~1 week; budget ~2–3
  weeks for a tight CI.

---

## 9. Files (create / touch)

- **New:** `supabase/functions/opening-maker-exit-loop/` (or extend `opening-capture`) — the tick shell;
  `supabase/migrations/00xx_maker_exit_measurement.sql` — the measurement columns + the gate-snapshot RPC.
- **Reuse (do not fork):** `core/sim/opening-maker-exit-replay.ts`, `opening-convergence.ts`,
  `opening-bracket-replay.ts` (`enterAndFill`), the bot tables (0066), `openingVerdict`.
- **Dashboard:** a `/maker-exit` panel (the forward gate snapshot + the 3 measured assumptions + the paper ledger).
- **Docs to update on a verdict:** `MAKER-EXIT-SIM.md`, `FINDINGS.md`, `OPENING-CONVERGENCE-HANDOFF.md`, `CLAUDE.md`.

---

## 10. Pointers

- The result this resolves: `MAKER-EXIT-SIM.md` (+ `CONVERGENCE-TUNING.md` Finding 1).
- The blueprint this specializes: `ARCHITECTURE-OPENING-CONVERGENCE.md` (the Phase-2 loop + the §J safety machine
  + the paper-fill ADRs — ADR-OC-4 bot_positions is state of record, the through-the-limit maker fill).
- The capture it reads: `supabase/functions/opening-capture` → `opening_captures` (LIVE).
- The gate it defers to: `core/sim/opening-convergence.ts` `openingVerdict` (frozen §9R-E).
- The pure decisions it calls: `core/sim/opening-maker-exit-replay.ts` `replayMakerExitEvent`.
