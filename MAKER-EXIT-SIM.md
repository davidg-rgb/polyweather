# Maker-Exit Simulation — the convergence edge, tested as a MAKER edge

> **✅ REGENERATED 2026-07-03 — the corrected archive PASSES the full-panel §9R-E gate at the SAME tuned config.**
> Both 2026-06-30 corrections below are RESOLVED: the archive was re-pulled canonically sorted (1 108 events,
> June-10→July-2 window — the whole seeded panel) and the sim re-run with the fixed rebate formula and a
> date-based train/test split. On the corrected **819-event / 45-city / 20-day** panel, the pinned
> `MAKER_EXIT_TUNED` config (tp 0.12 / sl 0.20 / tstop 18 h / chw 0 / maxEntry 0.30 / depth $150 / window 30):
>
> | scenario | n | winFrac | mean net | total $ | 95 % CI | zsMC | §9R-E |
> |---|---|---|---|---|---|---|---|
> | rebate 0 (fee-saving floor) | 382 | 62.8 % | **+6.7 %** | **+$515** | **[+0.3 %, +12.0 %]** | 3.2 % | **PASS** |
> | rebate 0.25 (weather tier, fixed formula) | 382 | 63.1 % | **+7.6 %** | **+$583** | **[+1.1 %, +12.9 %]** | 3.1 % | **PASS** |
>
> The bucket misalignment had been **depressing** the measured edge (+1.8 % → +6.7 % at rebate 0). The params were
> fitted on the *old misaligned* panel, so this run is a quasi-clean validation, not an in-sample fit; the 60/40
> date folds are both positive-mean (train +5.9 %, test +7.8 %) with zsMC clearing on each, though each fold alone
> is ciLow<0 (too few days per fold for the city-clustered CI). A coordinate re-sweep on the corrected panel
> re-confirms the tuned cell as the optimum on every axis (tp/sl/tstop/chw/maxEntry/window; depth robust across
> $100–225, $100 slightly stronger). **Four NEW levers were built, tested and REJECTED** (see §"the 2026-07-03
> improvement campaign" below): a per-city accuracy gate, an absolute "sell into 30+¢" take-profit, delayed entry,
> and a no-chase taker-fallback guard — each loses to the tuned baseline with a clear mechanism.
>
> **This is still a backtest on the calibrated synthetic book** — the frozen discipline stands: the LIVE forward
> paper loop (real books, real maker fills; `MAKER-EXIT-PAPER-LOOP-HANDOFF.md`) is the gate of record before any
> capital. Two live-loop alignment actions follow from this run (both operator-gated): widen the forward panel's
> scope from the 10-city trade allowlist to the 45-city capture universe (the 10-city subset is structurally
> starved: CI [−7.8 %, +13.9 %] even at n=88 — handler change committed, needs a redeploy), and flip
> `bot.consensusSource` `ensemble_raw` → `calibrated` (the PASS was measured with the calibrated gaussian seed;
> the live capture currently seeds the raw consensus, which selects 21 pp worse — Finding 2, re-confirmed on
> ~2 100 events).

> **🔬 JACKKNIFE ROBUSTNESS (2026-07-03 overnight, `scripts/research/jackknife-maker-exit.ts`) — the PASS is
> REAL but MARGINAL: point estimate robust, significance fragile at n=382.** Leave-one-out over the corrected
> panel at the pinned config (rebate 0):
>
> - **LOCO (45 runs):** 16 held-out cities flip PASS→KILL — but in EVERY flip the mean stays +5.2…+6.0 % and
>   ciLow is only just below 0 (worst: shenzhen, mean +5.2 %, CI [−0.5 %, +10.9 %]). No single city carries the
>   edge; the flips are thin-margin arithmetic on a ciLow of +0.3 %.
> - **LODO (20 runs):** 8 held-out dates flip (worst: 2026-06-15, mean +4.7 %, CI [−1.1 %, +10.5 %]). Same shape.
> - **The DAY-BLOCK tightening PASSES — and is *stronger* than the city gate:** day-clustered CI
>   **[+2.4 %, +12.6 %]**, day-flip MC 3.3 %. The edge is spread across days, NOT one lucky day or a same-day
>   common shock — the specific risk the 2026-06-28 review flagged (city-only clustering overstating df) does
>   NOT explain this panel. (`openingVerdict` now carries the tightening as OPT-IN `VerdictOpts.dayBlockNull` —
>   frozen-gate-safe: unset ⇒ byte-identical; set ⇒ PASS additionally requires the day-clustered CI to exclude 0
>   AND the day-block sign-flip MC to clear — a Phase-2 capital requirement, live before any real money.)
>
> Read: the +6 % point estimate survives every single-exclusion; the CI-excludes-0 criterion does not (24/65
> exclusions tip it). This neither strengthens nor weakens the standing discipline — it QUANTIFIES why the
> backtest alone is not a GO: the panel needs more days, which the live forward loop accrues daily. Full tables:
> `scripts/research/out/jackknife-maker-exit.md`.

> **📊 LEDGER DECOMPOSITION (2026-07-03 overnight, `scripts/research/maker-exit-ledger-analytics.ts`) — the
> ENTIRE edge rides on the maker take-profit leg; its LIVE fill rate is the one number that decides everything.**
> At the pinned config over the corrected panel (382 realized):
>
> | exit kind | n | win rate | mean return | total $ |
> |---|---|---|---|---|
> | maker_take_profit | 187 (49.0 %) | 100 % | +41.3 % | **+$1 543** |
> | taker_time_stop | 157 (41.1 %) | 33.8 % | −13.4 % | −$421 |
> | taker_stop_loss | 38 (9.9 %) | 0 % | −79.9 % | −$607 |
>
> Net +$515. The TP leg must out-earn a structural −$1 028 drag from the two taker exits — so the verdict is
> hyper-sensitive to the **realized maker-fill rate** (backtest: 49.0 % of realized exits; the live forward
> loop's early read is **0.30** on a tiny n — if that persists at scale, the edge inverts; this is assumption #1
> of `MAKER-EXIT-PAPER-LOOP-HANDOFF.md` §1, now with the precise sensitivity quantified). **Maker-fill latency:
> median 47 ticks ≈ ~16 h, p90 ≈ 34 h** (20-min cache cadence) — winning sells rest for MANY hours, so the live
> fill-rate read needs a measurement window spanning ≥ a day, and the resting order wears adverse-selection risk
> the whole time. Per-city: 26/45 net-positive; leaders (ankara/LA/singapore/dallas/houston) track the per-city
> accuracy table; the city-gate lever already showed gating on this does not survive the clustered CI. Full
> tables: `scripts/research/out/maker-exit-ledger-analytics.md`.

> **⚠ CORRECTION (2026-06-30, code review) — RESOLVED 2026-07-03, see the banner above.** The maker-rebate credit in `opening-maker-exit-replay.ts` was
> computed as `rebateRate · takerFeePerShare(p, **1**) · shares` — it dropped the fee-rate factor, so it credited
> the **full taker-fee magnitude** instead of a fraction of it (the `reward-farming.ts`/`reward-inventory.ts`
> convention `rebateRate · takerFeePerShare(p, **feeRate**) · shares`). Consequence: the **rebate-on** numbers
> below (**+5.1 % / +$313**, CI **[−1.6 %, +11.5 %]**) were run with `--rebate 0.05`, which under the old formula
> = **100 % of the taker fee** (≈ 4× the real **25 %** weather tier) — they are **overstated** and must be
> regenerated with the fixed engine (use `--rebate 0.25` for the weather tier). **Unaffected:** the **no-rebate
> +1.8 %** figure, and the **KILL verdict** — which the correction only *reinforces* (the true rebate is smaller).
> The **live forward loop pins `makerRebateRate = 0`**, so the §9R-E gate of record never used the inflated path;
> the forward loop **measures** the real rebate. (Fixed + pinned by a magnitude test in `opening-maker-exit-replay.test.ts`.)

> **⚠ CORRECTION (2026-06-30, code review) — RESOLVED 2026-07-03 (re-pulled + re-run with --split; banner above).**
> 1. **Archive bucket misalignment (shared with `CONVERGENCE-TUNING.md`).** This sim runs over the same local
>    archive via `tune-convergence.loadPanel`/`buildSet` → `buildHistoryEvent`. The archive was written in raw
>    Gamma order while the DB seed/winner are temperature-sorted, so the replay attached the wrong forecast prob +
>    winner to each bucket. Fixed at the root (`pull-market-history` now sorts canonically); **re-pull + re-run**.
> 2. **In-sample headline.** Unlike `tune-convergence` (which reports an out-of-sample TEST fold), the maker-exit
>    params were tuned and the §9R-E verdict measured on the **same** 708-event panel (winner's-curse). The +EV
>    figures are an in-sample upper bound; the true out-of-sample result is **no better** — which only **reinforces
>    the KILL**. The regenerated run should adopt the same date-based train/test split.
>
> Neither changes the **verdict (KILL / earns a forward test, not capital)** or touches the **live forward loop**
> (aligned `opening_captures`, not the archive). They mean the specific magnitudes here are not citable until re-run.

> **What it is.** `CONVERGENCE-TUNING.md` Finding 1 said the convergence edge is **real but a maker edge, not a
> taker edge** (the price-path edge is +8.2% frictionless, but the taker round-trip spread eats it → −3.0% net;
> breakeven at ×0.70 of the real spread). This is the build + simulation that **tests the redirect**: take profit
> as a **maker** (rest a sell at the take-profit limit; fill at the limit with $0 taker fee + the maker rebate;
> only when a later bid lifts it) with a **taker** stop-loss and a hard time-stop **at the latest 12–18 h before
> the market resolves** — then an **agent-team** coordinate optimizer fine-tunes the entry/exit params over the
> 708-event archive panel to **maximize net profit**, in a ≤3-round loop that stops on no-gain.
>
> **The headline.** The maker exit **flips the convergence strategy from clearly-negative to positive**: the same
> entry, exited as a maker, nets **+1.8 % (no rebate)** to **+5.1 % (+$313, with the measured weather maker
> rebate)** vs the taker exit's **−3.0 %**. It is the **first positive-EV configuration in the entire 12-signal
> program.** But it still **does NOT clear the frozen §9R-E gate** — the 17-day city-clustered 95 % CI is
> **[−1.6 %, +11.5 %]** (lower bound just below 0): positive in expectation, **not yet statistically clear of
> zero**. A near-miss in the right direction — it earns a **live forward test** (real maker-fill rates + the real
> rebate tier replace the two assumptions), **not** a capital GO. Rail stays **DORMANT**.

Status: **BUILT + TESTED + SIMULATED** (full suite 1757 green, typecheck clean). Read-only; the engine is pure +
no-look-ahead; the sim writes only `out/` artifacts. Places nothing, never imports `packages/trading`. Defers
every capital decision to a live forward §9R-E re-confirm + the operator.

---

## The strategy it measures

1. **Enter** the forecast-center bucket exactly as the live bot does (`enterAndFill` — the SHARED, tested entry
   path: `selectEntries` mode ± `centerHalfWidth`, edge + 20 %-cap + depth gates, maker-first fill). The maker
   ENTRY rests at the cheap limit and fills only if a later ask trades **through** it within `makerFillWindowMin`,
   else a taker fallback.
2. **Take profit as a MAKER** — rest a SELL at `entry + tpDeltaPp`; it fills **at the limit** ($0 taker fee + an
   optional maker rebate) only when a later tick's **bid reaches the limit** (a buyer lifts the offer). This is
   the spread/fee recovery Finding 1 said the edge needs. **NO LOOK-AHEAD** — the fill is decided at the tick the
   bid reaches it, never retroactively.
3. **Cut losses + flatten as a TAKER** — the stop-loss (the F13 ternary) and the hard time-stop (**resolvesAt −
   `tstopHoursBeforeResolve`**, the spec "exit … or at the latest N hours from bet closing") both cross into the
   bid + pay the taker fee. You **cannot** rest above a falling market — that is exactly the **§12 adverse-selection
   wall** this engine measures honestly: the maker TP only fills on FAVORABLE moves; every stalled/adverse one
   carries to the taker time-stop. The net is (spread + fee + rebate recovered on the up-fills) − (the taker
   flattens on the rest).

The engine is `packages/core/src/sim/opening-maker-exit-replay.ts` (`replayMakerExitEvent` / `replayMakerExitPanel`);
the entry leg is shared with the taker bracket engine via the extracted `enterAndFill` (one tested entry path).

---

## The simulation + the agent-team optimization loop

`scripts/research/sim-maker-exit.ts` runs the strategy over the **708-event / 45-city / 17-day** resolved archive
panel (the same panel `CONVERGENCE-TUNING.md` tunes), joined to the bot's real `house_gaussian` seed, on the
calibrated synthetic book (×1). It prints a **per-trade ledger** (entries + exits, "like the logged potential
entries & exits") + the §9R-E verdict, and is **cache-backed** (`--build-cache` once → `--from-cache` fast) so a
fan-out of agents can each line-search a coordinate in one command (`--sweep "param:v1,v2,…"`).

The optimizer is a **dynamic Workflow** (`tune-maker-exit`): a ≤3-round **coordinate descent run by an agent
team**. Each round, **7 agents in parallel** each line-search one coordinate (`tp`, `sl`, `tstopHours`, `chw`,
`maxEntry`, `depth`, `makerWindow`) against the incumbent; a **verify agent** then scores the combined candidates
(objectives don't add across coordinates); the orchestrator promotes the best and **stops when a round yields no
gain** (or after 3 rounds). The objective is **mean realized net return, credited only when ≥ 40 markets clear**
(so it can't "win" on a handful of lucky trades). 24 agents, ~4.5 min. Every reported number was **independently
re-run by hand** (the prior workflow-review miss is on record — agent outputs are verified, not trusted).

### The trajectory (rebate 0.05 scenario — the measured weather maker rebate)

| round | params | mean net | via |
|---|---|---|---|
| 0 (baseline) | tp .10 · sl .20 · tstop 12h · chw 0 · maxEntry .30 · depth $100 · window 15 | **+1.1 %** | — |
| 1 | tp **.12** · tstop **18h** · window **30** | **+4.9 %** | all-improving coords |
| 2 | depth **$150** | **+5.1 %** | single coord |
| 3 | (no improvement) | +5.1 % | **STOP — no gain** |

**Final tuned params:** `tp 0.12 · sl 0.20 · tstopHours 18 · centerHalfWidth 0 · maxEntryPrice 0.30 ·
depthFloorUsd 150 · makerWindow 30`. The biggest levers: **`makerWindow` 15→30** (the maker ENTRY now also fills,
recovering the entry-leg spread, not just the exit), `tp` 0.10→0.12, `tstop` 12→18 h (hold longer so the maker TP
has time to be lifted), `depth` 100→150 (deeper, higher-quality entries).

---

## The verified result

| scenario | n | maker-exit % | winFrac | mean net | total $ | 95 % CI | §9R-E |
|---|---|---|---|---|---|---|---|
| taker exit (CONVERGENCE-TUNING) | 355 | — | 60.3 % | **−3.0 %** | −$107 | [−9.9 %, +4.0 %] | KILL |
| **maker exit, tuned, rebate 0** | 308 | 43 % | 57.8 % | **+1.8 %** | **+$109** | — | KILL |
| **maker exit, tuned, rebate 0.05** | 308 | 43 % | 58.8 % | **+5.1 %** | **+$313** | **[−1.6 %, +11.5 %]** | KILL |

The maker exit **moves the edge from clearly-negative to positive** — confirming Finding 1's mechanism. It is the
**first positive-EV configuration found across all twelve signals.** Yet the **§9R-E gate KILLs both**: the
city-clustered CI lower bound is **−1.6 %** (rebate 0.05) — positive in expectation, but over only **17 distinct
days** the day-clustered variance is wide enough that the edge is **not yet statistically clear of zero**. The
zero-skill MC clears (2.8 % < 5 %) and winFrac clears (58.8 % > 50 %); the binding miss is **ciLow ≤ 0**.

A sample of the per-trade ledger (`out/maker-exit-ledger.{csv,md}`) — the winners take profit as makers (+35–60 %),
the losers flatten as takers at the time-stop/stop (−10 to −90 %):

```
nyc        2026-06-24 82-83°F buy 0.315T → M:take_profit  sell 0.435 = +$7.71 (38.6%)
ankara     2026-06-19 23°C    buy 0.271T → M:take_profit  sell 0.391 = +$9.00 (45.0%)
chongqing  2026-06-18 ≤23°C   buy 0.233M → M:take_profit  sell 0.353 = +$12.05 (60.3%)
london     2026-06-23 35°C    buy 0.310T → T:time_stop    sell 0.182 = −$9.41 (−47.1%)
amsterdam  2026-06-27 33°C    buy 0.229T → T:stop_loss    sell 0.028 = −$18.44 (−92.2%)
```

---

## The 2026-07-03 improvement campaign — four new levers built, tested, REJECTED

The operator asked for a full check-and-improve pass on the convergence setup (entry pick, exit structure,
timing, per-city source accuracy). Foundation first: the archive was **re-pulled canonically sorted** (the
2026-06-30 misalignment fix) and every number regenerated — see the top banner (the tuned config now **PASSES**
the full-panel gate). Then four new levers were implemented as engine/harness options (all default-off,
byte-identical when unset), swept with the 60/40 date-split OOS discipline, and **all four rejected**:

| lever | engine knob | best variant | full-panel result vs baseline +6.7 % CI[+0.3, +12.0] | why it loses |
|---|---|---|---|---|
| per-city accuracy gate | `cityGateLb` (Wilson-LB floor on the PRE-panel per-city hit table `CITY_GATE_PRE0613`, fitted 05-13→06-12 — temporally OOS for the whole replay) | lb 0.7/hit1 (17 cities) | mean +8.3 % but CI [−2.7 %, +16.3 %] → KILL | concentration cuts the CITY-cluster count → the clustered CI widens faster than the mean improves; bad-selector cities still contribute (the exit sells into the mid-life convergence, not resolution) |
| absolute take-profit ("sell into 30+¢") | `tpMode:'abs'` + `tpAbsTarget` | 0.40 | +4.0 % CI [−2.3 %, +9.3 %] → KILL (0.30 → −0.7 %; 0.25 → −3.5 %) | the harvest is **entry-relative**: a level target forces near-entry exits on expensive entries (tiny wins, full-size losers) and over-asks on cheap ones |
| forecast-prob take-profit | `tpMode:'model'` (rest AT our prob) | — | +4.8 % CI [+0.6 %, +10.7 %] → PASS but below baseline | the mode's prob (~0.35–0.45) over-asks vs the +12 pp sweet spot — fewer fills, more time-stops |
| delayed entry ("wait for a dip") | `minEntryAgeH` | 2 h / 4 h / 8 h | −1.0 % / −4.6 % / −7.3 % → KILL, monotone | **the first enterable tick IS the low** — the convergence prices in fast; every hour of delay forfeits re-rating |
| no-chase taker fallback | `noChaseTakerFallback` | on | +5.4 % CI [−2.5 %, +11.3 %] → KILL | a book that runs away during the maker rest is running *toward* the convergence — refusing to chase forfeits more winners than it avoids losers (the 0.465-entry LA loser is real but outweighed) |

Plus the classic-coordinate re-sweep on the corrected panel: **tp 0.12 / sl 0.20 / tstop 18 h / chw 0 /
maxEntry 0.30 / window 30 is the unique PASS cell on every axis** (each ±1 step lowers ciLow); depth is robust
across $100–225 (100: ciLow +1.1 %; 150: +0.3 %; 225: +0.1 % — the pin keeps $150, selected on TRAIN).

**The per-city source-accuracy question (the operator's hypothesis) was answered on ~2 100 resolved events**
(3× this panel, all 45 cities, leads 0/1/2): the **calibrated house blend dominates every individual source at
every lead** (hit-±1 88 %/79 %/75 % at lead 0/1/2 vs the best single NWP model ~70 %/66 %/62 % and the raw
ensemble 66 %/62 %/59 %). No per-city single-model override survives multiple-comparisons scrutiny (the 8
cities where one model beats the blend >10 pp are best-of-10 picks at n≈48 — and mostly the low-accuracy
cities anyway). Per-city accuracy VARIES enormously (karachi/LA/miami ≥95 % bracket at lead 1; amsterdam 52 %)
— but per the gate test above, that variation is not harvestable as a trade filter; its real use is the
**seed choice** (calibrated > raw, everywhere) and the eventual capital-scope decision. The commercial Lane-B
sources (google/OWM/WeatherAPI) have only days of history — re-scoreable in ~a month.

## What this changes — and the load-bearing assumptions

- **It is NOT a GO.** The gate is the law; ciLow ≤ 0 → KILL → the rail stays DORMANT and **no live config
  changes**. The other eleven signals stay dead.
- **It IS the first thing worth a real forward test.** The maker exit is the only mechanism that has produced a
  positive expectation. The verdict turns on **three assumptions the backtest cannot resolve** — only a live
  forward run can:
  1. **The maker-fill model.** A resting sell is modeled to fill when the bid reaches the limit. Real fills depend
     on queue position + adverse selection (§12) — the live fill rate could be lower (worse) or the captured
     spread higher (better). The conservative model still nets positive, which is the encouraging read.
  2. **The rebate.** `0.05` mirrors the measured weather maker-rebate magnitude (`MAKER-REBATE-HANDOFF.md`), but
     the real tier depends on volume. At **rebate 0** (pure fee-saving) it is still **+1.8 %** — so the result
     does not hinge entirely on the rebate, but the rebate is what makes it comfortably positive.
  3. **17-day temporal extent.** The day-clustered CI is wide because there are only 17 days. More days (re-pull
     the archive, re-run) tightens it; if the +5.1 % mean holds, ciLow crosses 0 and the gate flips.
- **Recommended forward test (operator-gated).** Wire the maker-exit lifecycle into the dormant bot's paper loop
  (it already makes the entry; add the maker TP + the resolvesAt−Nh time-stop), capture **real** maker fills +
  the **real** rebate tier, and let the live §9R-E gate adjudicate on real-book depth. The tuned params above are
  the starting point, **re-validated forward** (the sweep is in-sample; the OOS discipline still applies).
  **Build-ready spec: `MAKER-EXIT-PAPER-LOOP-HANDOFF.md`** — reuses the live capture + the bot tables + the pure
  maker-exit core; measures the three assumptions for real; paper-only, hard-gated, operator funds/keys.

---

## Files

- `packages/core/src/sim/opening-maker-exit-replay.ts` (+ test) — the pure no-look-ahead maker-exit engine.
- `packages/core/src/sim/opening-bracket-replay.ts` — `enterAndFill` extracted here (shared entry leg) + reused.
- `scripts/research/sim-maker-exit.ts` — the cache-backed sim (per-trade ledger + `--sweep` + the rebate scenarios).
- `scripts/research/tune-maker-exit.workflow.js` — the agent-team coordinate-optimizer Workflow (committed for repro).
- `out/maker-exit-ledger.{csv,md}`, `out/maker-exit-cache.json.gz` — artifacts (gitignored).

## How to re-run

```
pnpm tsx scripts/research/sim-maker-exit.ts --build-cache                                   # once (DB + archive)
pnpm tsx scripts/research/sim-maker-exit.ts --from-cache --rebate 0.05 \
  --tp 0.12 --sl 0.20 --tstop-hours 18 --chw 0 --max-entry 0.30 --depth 150 --maker-window 30
# re-run the agent-team optimizer: Workflow({ name or scriptPath: tune-maker-exit.workflow.js })
```
