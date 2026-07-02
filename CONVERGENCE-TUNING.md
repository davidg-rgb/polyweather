# Convergence Tuning — the 708-event archive verdict on the bot's entry/exit thresholds

> **✅ RE-PULLED + REGENERATED 2026-07-03.** The archive's seeded window (June 10 → July 2, 1 108 events, all 45
> cities) was re-pulled with the canonical bucket sort and both harnesses re-run on the grown **819-event /
> 45-city / 20-day** panel. Headline movements: the misalignment had been **understating** the edge — the
> maker-exit variant now **PASSES the full-panel §9R-E gate at the same tuned params** (+6.7 % rebate-0 /
> +7.6 % rebate-0.25, CI excl 0 — see `MAKER-EXIT-SIM.md`, which also records the 2026-07-03 improvement
> campaign: four new levers tested + rejected, coordinate optimum re-confirmed). The regenerated TAKER verdict:
> **still KILL** (best OOS cell: FULL +2.5 %, CI [−5.0 %, +9.9 %]) — but the **breakeven spread moved ×0.70 →
> ×1.14**: on correctly-aligned buckets the taker price-path edge is positive in expectation even AT the
> calibrated spread; it fails only the statistical bar (ciLow ≤ 0). Finding 1's direction stands (the maker
> exit is where the edge clears the gate); **Finding 2 re-confirms almost exactly** (gaussian brackets the
> winner 74.4 % vs `ensemble_raw` 53.0 % at chw1 on 819 events; 79 % vs 62 % at lead 1 on the ~2 100-event
> DB panel). The historical numbers in the body below are the ORIGINAL (misaligned-archive) run, kept for the
> record — cite the regenerated ones.

> **⚠ CORRECTION (2026-06-30, code review) — RESOLVED 2026-07-03 (see above).**
> The local price-history archive was written by `pull-market-history` in **raw Gamma market order**, but the DB
> house seed (`bucket_probabilities.probs`) and `winner_idx` it is joined to are in the DB's **temperature-sorted**
> bucket index space (`parseGammaEvent` sorts by `bucketRange.lo`). The two index spaces **diverge** (the open
> tails land mid-array in raw order), so `history-replay-ingest.buildHistoryEvent` attached each archive bucket's
> price path to the **wrong** forecast prob and graded it against the **wrong** winner. The replay-based numbers
> here (+8.2% gross, the breakeven ×0.70, the per-cell P&L, the PASS/KILL) were therefore computed on **misaligned
> buckets** and are NOT reliable. **Fixed at the root:** `pull-market-history` now sorts each event's buckets into
> the DB canonical order before assigning idx (so the archive shares ONE index space with the DB everywhere). The
> existing on-disk archive is still raw — **re-pull it (`pull-market-history --refetch`) and re-run this tuner**;
> the `house_gaussian` SELECTOR diagnostic (the 73.9% bracket rate) reads the DB seed+winner directly and is
> **unaffected**, and so is the **live forward loop** (it uses `opening_captures`, aligned by label, not the archive).
>
> **What it is.** A read-only tuning harness that turns the local price-history archive
> (`scripts/research/out/market-history`, 6 275 events / ~238 M points) — joined to the bot's **real**
> forecast seed (`bucket_probabilities`) and the true resolution — into the **largest backtest of the
> opening-convergence bracket strategy** the project can build, then sweeps the bot's entry/exit thresholds
> over it to find the set that maximizes net P&L, validated **out-of-sample**.
>
> **The headline.** On a **708-event / 45-city / 17-day** resolved panel (June 13–29 2026), **no tuned
> threshold set clears the frozen §9R-E net-profit gate** at the calibrated executable spread — the
> convergence **price-path edge is real** (+8.2% gross at a frictionless book) but the **round-trip spread +
> fees the taker pays consume it** (breakeven at **×0.70** of the real spread). The 12th signal meets the same
> efficiency wall as the other eleven — now measured on 708 events, not the live n≈2. **But the tuning surfaced
> two genuinely new, decision-grade findings** (below). Rail stays **DORMANT**; this is analytics, not a GO.

Status: **BUILT + TESTED + RUN** (full suite green, typecheck clean). Read-only; reads the DB seed + the local
archive; writes only `out/` artifacts. Places nothing, never imports `packages/trading`. Defers every capital
decision to the live forward §9R-E capture + the operator.

---

## Why this exists

The forward bracket-exit screen (`opening-bracket-score.ts`, `OPENING-BRACKET-REPLAY.md`) is **starved**: its
§9R-E gate needs ≥40 resolved markets but the live `opening_captures` enterable+filled panel is **n≈2**. We
cannot tune thresholds — or even render a PASS/KILL — on two markets. Meanwhile the last sessions pulled the
**full price-history archive** (every °C bucket's minute-by-minute implied-prob path, with resolution) and the
DB already holds the bot's **real `house_gaussian`/`house_ensemble` seed** for 708 of those resolved events.
Joining them gives a panel **~350× the live one** — enough for the §9R-E verdict **and** a real train/test split.

This harness runs the **same pure engine** the live capture drives (`replayEvent`/`replayPanel` — one source of
truth, no logic fork) over that panel, across a grid of entry/exit thresholds, and reports the out-of-sample
verdict at each. It is the data-driven answer to "**how do we best tune the convergence bot's entry/exit
decisions on a per-market basis**".

---

## The one load-bearing approximation — and how it's handled honestly

The CLOB prices-history archive is **mid-price-only**: one implied-prob point per bucket per minute, with **no
two-sided book, no depth, no house seed**. So the harness **synthesizes** a two-sided book from the mid via
**`CALIBRATED_BOOK`** (`core/sim/history-replay-ingest.ts`) — a piecewise-by-mid spread + depth model **fit from
the live `opening_captures` real books** (median `execAsk−mid`, `mid−execBid`, `depthUsd` by mid band; regen via
`scripts/research/calibrate-history-spread.ts`). The cheap entry zone is genuinely **thin and wide** — at mid
0.07–0.17 the real books show only **$4–$90** of walked depth and **~3–4pp** round-trip — which is *why* the
synth matters and *why* the result is what it is.

Because a synth is still a synth, the harness does **not** rest the conclusion on it:
- it **sweeps a `spreadMult`** (0 = frictionless → 2 = double the calibrated spread) and reports the **breakeven
  spread** (the multiplier at which the edge crosses zero);
- it therefore measures the **price-path edge** (does the convergence re-rating clear spread + fees) and the
  **thresholds that maximize it** — and **defers executable depth at size** to the live forward §9R-E capture on
  real books. The historical harness sets the thresholds; the live gate certifies they fill.

The **`houseProb` seed is the bot's real archived forecast** (`bucket_probabilities`, earliest `made_at` per
event = the listing-time seed, **no look-ahead**), aligned to the archive buckets by index/label. The harness
never reconstructs a forecast — it only assembles the tick series the engine reads.

---

## The method (what the harness does)

1. **Panel** — every DB `market_events` row that is **resolved** AND has a `house_gaussian` seed AND a local
   archive file: **708 events · 45 cities · 17 days**. The bot's 10-city allowlist cut is **162 events**.
2. **Selection diagnostic** — per selector (`house_gaussian` vs `house_ensemble`) × `centerHalfWidth`, does the
   forecast **bracket the eventual winner**? (the dominant lever — see below). Plus the winner's harvestable
   re-rating (its peak mid − open mid).
3. **Entry grid on TRAIN → validate OOS on TEST** (calibrated spread ×1): sweep
   `centerHalfWidth ∈ {0,1,2}` × `maxEntryPrice ∈ {0.15,0.20,0.25,0.30}` × `depthFloorUsd ∈ {25,50,100}` × the
   take-profit, score each on **TRAIN** (earliest 60% of dates), **select** the best (winner's-curse-aware: PASS
   rows by max `ciLow`, else closest-to-passing), then evaluate that **same** cell+TP on **TEST** (the held-out
   later dates) and on the full panel.
4. **Take-profit sweep**, **spread sweep → breakeven**, and an **exit sweep** (stop-loss × time-stop) at the
   selected cell.
5. **Verdict + recommended config** — gated behind the frozen §9R-E `openingVerdict` (≥40 markets, ≥6 cities,
   ≥7 days, winFrac ≥ .5, city-clustered `ciLow > 0`, zero-skill MC < 5%). PASS only if it clears **out-of-sample**.

Run: `pnpm tsx scripts/research/tune-convergence.ts` (`--allowlist` for the 10-city cut, `--sample-min N` for the
tick cadence). Artifacts → `out/tune-convergence.{md,json}`.

---

## The results

### Finding 1 — the convergence edge is REAL, but it is a MAKER edge, not a taker edge

The spread sweep at the best entry cell (full 45-city panel) is the crux:

| spread× | n | winFrac | mean net return | 95% CI | §9R-E |
|---|---|---|---|---|---|
| **×0** (frictionless) | 407 | 70.3% | **+8.2%** | [2.7%, 13.7%] | **PASS** |
| ×0.5 | 382 | 65.7% | +1.9% | [−5.1%, 9.0%] | KILL |
| **×1** (calibrated) | 355 | 60.3% | **−3.0%** | [−9.9%, 4.0%] | KILL |
| ×1.5 | 331 | 55.0% | −10.4% | [−17.2%, −3.7%] | KILL |
| ×2 | 307 | 47.6% | −17.6% | [−24.2%, −11.1%] | KILL |

**Breakeven spread: ×0.70 of the real (calibrated) spread.** The convergence re-rating genuinely exists — buying
the forecast center and selling into the convergence nets **+8.2%** when the book is frictionless. But the
**taker round-trip** (buy at the ask, sell into the bid, + the 5% weather fee on both taker legs) costs more than
the re-rating delivers: the edge dies once the spread exceeds **70%** of what real books actually charge. **The
spread the convergence creates is captured by the market-maker who quotes it, not by the taker who crosses it.**

This is the **same efficiency wall** the project hit eleven other ways (`FINDINGS.md`) — the edge is real but not
executable **net of microstructure cost** — now confirmed for the 12th signal on **708 events** instead of n≈2.

**The motivated redirect (a HYPOTHESIS, not a GO).** A breakeven at ×0.70 means recovering even ~30% of the
spread flips the sign. The taker pays the full spread; a **maker earns it** (+ the rebate). The bot already
makes the **entry** leg; the killer is the **taker exit** (it sells into the bid). Resting a **maker exit** (and
banking the maker rebate) is the natural next test — **but** it must clear the **§12 maker-spray adverse-selection
FAIL** (`WALLET-RECON-HANDOFF.md §12`: a resting order fills preferentially when the price moves *against* you),
which is exactly the failure mode a maker exit invites. So this is a **measured-forward hypothesis** the data
motivates, not a green light. It is the one lever this verdict leaves genuinely open.

> **↳ TESTED 2026-06-30 (`MAKER-EXIT-SIM.md`).** The maker-exit variant was built + simulated over the same panel,
> with an agent-team optimizer maximizing net profit. It **flips the edge positive** — the same strategy nets
> **+1.8 % (no rebate) / +5.1 % / +$313 (measured rebate)** vs the taker's −3.0 % — the first positive-EV config in
> the program. But it **still KILLs the §9R-E gate** (17-day CI [−1.6 %, +11.5 %], ciLow just below 0): positive in
> expectation, not yet statistically clear of zero. Earns a live forward test, not capital. Rail stays DORMANT.

### Finding 2 — the convergence seed should be the CALIBRATED gaussian, not the raw ensemble

The selection diagnostic — does the forecast bracket the eventual winner — is decisive and **contradicts an
assumption baked into the live bot**:

| selector | chw0 (mode only) | chw1 (mode ±1) | chw2 (mode ±2) |
|---|---|---|---|
| **`house_gaussian`** (calibrated) | 33.6% | **73.9%** | **91.2%** |
| `house_ensemble` (raw) | 21.9% | 52.8% | 73.4% |

The **calibrated `house_gaussian` brackets the winner 21pp more often** than the raw ensemble at every width
(73.9% vs 52.8% at chw1). The 2026-06-29 convergence/accuracy split set the bot's convergence seed to
**`ensemble_raw`** on the theory that the play bets on *what the crowd believes* (the raw consensus the consumer
weather apps show), so a truth-correction that helps the accuracy paper-trade would *hurt* the convergence. That
logic may still hold for **where the price converges to** — but for the prior question, **which bucket to enter so
that it re-rates up**, the data says the **bias-corrected forecast selects materially better**. Worth the
operator's attention: `bot.consensusSource` is currently `ensemble_raw`; for the *selection* objective,
`calibrated` (the gaussian) is the stronger seed on this panel. (Both still KILL net of cost — see Finding 1 —
so this is a *seed-quality* correction, not a path to a GO.)

### The full verdict (calibrated spread ×1)

The best out-of-sample cell — the most selective, highest-quality entries (`gaussian, chw0, maxEntry 0.30,
depth $100, TP +10%`) — still **KILLs**:

```
SELECTED on TRAIN (closest-to-passing): gaussian chw0 max0.30 depth$100 TP+10%
  TRAIN: n=175 winFrac 58.9% meanNetRet +0.7% CI[-7.9%,9.4%] → KILL
  TEST  (OOS): n=180 winFrac 61.7% meanNetRet -2.6% CI[-10.0%,4.8%] → KILL
  FULL panel:  n=355 winFrac 60.3% meanNetRet -3.0% CI[-9.9%,4.0%] → KILL
```

- **Take-profit** is not the lever: every TP from +4% to +25% is KILL (least-bad +8% at −1.0% on the 45-city
  panel). The convergence rarely runs far enough for a high TP, and a low TP harvests too little to clear costs.
- **Exit timing** is not the lever either: the best exit cell (loose stop `SL 0.20` + the noon/`14:00` time-stop)
  reaches only ~+0.2…+0.5% mean (CI still spans 0). A **tight** stop (`0.08`) is much worse (−7.6%) — the
  cheap-bucket noise stops you out before the convergence resolves. The dominant constraint is **selection +
  cost**, not when you exit.
- The bot's **10-city allowlist** cut (162 events) is **no better** — best OOS TEST **−5.0%**, breakeven
  spread ~×0.55. (`out/tune-convergence-allowlist.md`.)

This matches the reality-check that motivated the build: **cheap buckets (open price 0.05–0.20) re-rate DOWN by
half-life on average** (mean −6pp); only the cheap bucket adjacent to the eventual mode re-rates up. The edge is
entirely in the **selection**, and even a 74%-accurate selector cannot overcome the **taker spread** on the
losers it inevitably also buys.

---

## What changes (and what doesn't)

- **Live config: NOTHING changes.** No cell clears the gate out-of-sample; the §9R-E discipline is the law. The
  opening-convergence rail stays **DORMANT**. (`ARCHITECTURE-OPENING-CONVERGENCE.md`, `OPENING-CONVERGENCE-HANDOFF.md`.)
- **The recommended (closest-to-passing) thresholds** are recorded for the operator, **not** applied:
  `house_gaussian` · `centerHalfWidth 0` · `maxEntryPrice 0.30` · `depthFloorUsd 100` · `tpDeltaPp 0.10` ·
  `slDeltaPp 0.20` · `timeStopLocalHour 12`. These are the *least-losing* knobs, not a profitable set.
- **Two operator notes** carried forward: (1) if the maker-exit redirect is ever tested, it must beat the §12
  adverse-selection wall; (2) for the *selection* objective, the calibrated gaussian out-selects `ensemble_raw`.

---

## Files

- `packages/core/src/sim/history-replay-ingest.ts` — the PURE bridge: `synthBook` (calibrated two-sided book from
  a mid), `CALIBRATED_BOOK`, `buildHistoryEvent` (archive event → the engine's `EventReplayInput`, with the
  verdict-preserving end-of-weather-day tick trim), `selectionDiagnostic`. Reuses the existing engine verbatim.
- `packages/core/test/history-replay-ingest.test.ts` — book ordering, spread scaling, the trim, the engine seam,
  resolution fallback, totality.
- `scripts/research/tune-convergence.ts` — the read-only tuner (DB seed ⋈ archive, the grid, the OOS split, the
  breakeven, the report). Pure helpers (`splitByDate`, `pickBest`, `breakevenSpread`, `rowPasses`) are tested.
- `scripts/research/tune-convergence.test.ts` — the pure-helper + seam tests + the no-DB `sanity()`.
- `scripts/research/calibrate-history-spread.ts` — refit `CALIBRATED_BOOK` from the live books (`--check` diffs
  vs the committed model).
- `out/tune-convergence.{md,json}` (45-city), `out/tune-convergence-allowlist.md` (10-city) — the run artifacts
  (gitignored).

## How to re-run

```
pnpm tsx scripts/research/tune-convergence.ts --sample-min 20            # full 45-city panel (~2 min)
pnpm tsx scripts/research/tune-convergence.ts --sample-min 20 --allowlist # the bot's 10-city universe
pnpm tsx scripts/research/calibrate-history-spread.ts --check             # verify the synth book vs live
```

The panel grows as more events resolve with a `house_gaussian` seed; re-pull the archive
(`pull-market-history`) and re-run to extend the temporal extent (currently 17 days — the binding limit on the
day-clustered CI). A maker-exit variant of the engine would be the way to test Finding 1's redirect.
