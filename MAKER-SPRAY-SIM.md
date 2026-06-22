# MAKER-SPRAY-SIM — requirements (baseline for the architect blueprint)

> **What this is.** The baseline requirements doc for the **maker-spray paper simulator** — the
> read-only study that closes the **4th and last** badatmath replication angle. Three angles are already
> falsified (`WALLET-RECON-HANDOFF.md`): forecast-beats-market (KILL-GATE 2), day-before-edge (KILL-GATE 2),
> copy-trade-mirror (§11). The one variable never directly measured: **does resting a MAKER bid below the ask
> (badatmath's actual entry — fill ~0.107 vs ask ~0.181, ~7pp below) on OUR EMOS forecast clear zero EV?**
> KILL-GATE 2 measured `calibratedP − ask`; this measures `calibratedP − rested_bid` with a fill model that
> embeds adverse selection. **Posture: analytics study, NOT a trading green-light. Ships nothing to prod, no
> migration, no live rail, never imports `packages/trading`. Pre-registered kill-criterion (WO-5 discipline).**
> The expected outcome is a clean efficiency confirmation; the deliverable is the measurement either way.

---

## 1. Goal (one sentence)

A pure, deterministic, read-only paper simulator that — over the existing backfill — walks our live EMOS
forecast forward day-by-day, sprays badatmath-style **resting maker bids** on the cheap (<0.25) buckets of
each resolved bucket market, simulates which bids **fill** from the real `market_snapshots` book evolution
(this is what captures adverse selection for free), grades filled positions against `winning_bucket_idx`, and
adjudicates a **pre-registered** fee-net-EV kill-criterion — quantifying whether a maker entry on our forecast
is +EV, where the taker entry already provably is not.

## 2. The question, precisely (why this is not a re-run of KILL-GATE 2)

- KILL-GATE 2 (`db1-daybefore-efficiency.ts`) measured `edge = calibratedP − **ask**` → +0.46pp, CI straddles 0,
  Brier(ours) worse than the market. Taker entry on our forecast is efficient. **Settled.**
- badatmath does **not** pay the ask. It **rests** bids ~7pp below it and is filled as a maker (copy-trade §11:
  fill 0.107 vs ask 0.181; fill −4.76% below mid; 65% of fills below mid). Its edge at its rested price is
  +1.34pp — thin, and from **superior** calibration (Brier 0.350).
- **Open question:** with the ~7pp cheaper maker entry, does **our** (inferior) forecast cross zero? Prior is
  **no** — a resting bid is filled *preferentially when the ask falls toward it*, i.e. on buckets the market is
  marking **down** (adverse selection); being a maker amplifies, not cures, a calibration deficit. But it has
  **not been measured.** This module measures it. If it clears, that is genuinely new information; if not, the
  4th angle is falsified and the rail stays dormant on a number, not a prior.

## 3. Scope / non-goals (hard boundaries)

**In scope (read-only):**
- New pure module `packages/core/src/sim/maker-spray.ts` (+ `maker-spray.test.ts`).
- New research script `scripts/research/maker-spray-feasibility.ts` (+ `.test.ts`) — forks the `db1`
  EMOS/loader spine; **does not edit** the shared `mos-pointskill` / `db1` harness.
- Reuse, never reimplement: `gaussianBucketProbs` (`distributions/gaussian.ts`), EMOS
  (`correctPoint`/`computeModelWeights`/`fitSigma`/`updateBias`, `calibration/emos.ts`), `armEdgeStats` /
  `bootstrapMeanCi` / `wilsonInterval` / `meanConfidenceInterval` / `GradedBet` (`sim/stats.ts`),
  `takerFeeTotal` / `takerFeePerShare` (`fees.ts`), the `EmosStation` walk-forward engine + the event/ladder
  loaders from `db1-daybefore-efficiency.ts`, and the `BucketSnapshot` series shape +
  `snapshotAtOrBefore/AtOrAfter` from `sim/copy-trade.ts`.

**Out of scope (do NOT touch):**
- `packages/trading/**` — no executor, no gate, no SDK, no `goLiveGate`. This module must not import it.
- No migration, no new table, no Edge Function, no cron, no `/amsterdam` or any web surface change.
- No write to any prod table. Read-only queries only.
- No change to the live model, `openmeteo.ts`, `0010_seed.sql`, or `dash_amsterdam_sim`.

## 4. Inputs / data sources (all already in the DB)

| Need | Source | Note |
|---|---|---|
| Walk-forward EMOS μ, σ → calibrated bucket probs | `forecast_snapshots` (slot `backfill`) + finalized `observations`, via the `db1` loaders + `EmosStation` | fork verbatim; the fork-correctness RMSE check (≈**1.2991°C** vs `mos-pointskill` same-window) is the contract |
| Resolved bucket markets + ladders | `market_events` (`winning_bucket_idx`, `ladder_ok`, `target_date`, `unit`, `icao_at_creation`) + `market_buckets` (`bucket_idx`, `low_native`, `high_native`, `fee_rate`, `tick_size`, `min_order_size`, `id`) | same as `db1` |
| **Full day-before book time-series per bucket** | `market_snapshots` (`best_bid`, `best_ask`, `mid`, `captured_at`) — **ALL rows** in the entry→resolution window, not just the last ask | this is the change from `db1` (which takes only the last ask). The maker fill model needs the whole series. `BucketSnapshot[]` ASCENDING by `captured_at`. |

## 5. The core model — maker fill simulation (the one novel piece)

For each resolved bucket of each event, given our calibrated `calibratedP`, the bucket's `BucketSnapshot[]`
series, and an entry time `t_enter`:

1. **Entry time `t_enter`.** Default: the badatmath-style lead — `target_date − ~1.8 days` (median lead 43.2h,
   §11). Robustness variants: day-before only (`target_date − 1d`), and 2-days-out. Use the first snapshot at/
   after `t_enter` as the entry book.
2. **Rested bid price `p_rest`.** Default: the **best_bid at entry** (where badatmath rests). Variants: `bid + 1
   tick` (priority), and a fixed offset below the ask (e.g. `ask − 0.07`, the observed ~7pp). Bound to the tick
   grid; only buckets whose entry book has a usable bid/ask qualify; **only `p_rest < cheapMax` (default 0.25)**
   enters the cheap-longshot study (the subset the kill-criterion lives on).
3. **Fill model (embeds adverse selection — the honest core).** A resting BUY at `p_rest` fills iff, at **some**
   snapshot in `(t_enter, resolution)`, `best_ask ≤ p_rest` — i.e. a seller crossed down to our price. From the
   series: `filled = min(best_ask over the post-entry window) ≤ p_rest`. This naturally fills our bids
   *preferentially on buckets whose ask collapses* (the losers) and leaves bids on rising/winning buckets
   **unfilled** — exactly the maker adverse-selection trap. A spec-time alternative for the architect to weigh:
   a `last_trade ≤ p_rest` print as the fill trigger (sharper but sparser). Pick the conservative default, expose
   the other as a variant, document the choice.
4. **Fee / rebate.** Default conservative: charge the same `takerFeeTotal(p_rest, shares, feeRate)` and **no
   maker rebate** (copy-trade's choice — the maker bound's edge must come from the cheaper price, not an assumed
   rebate). Expose an optional `makerRebate` knob (Polymarket weather maker rebate, if/when known) as a
   sensitivity, clearly flagged as optimistic.
5. **Grade.** Filled position on bucket `b`: `won = (b === winning_bucket_idx)`; per $1 `shares = 1/p_rest`,
   `won → shares·(1−p_rest) − fee`, else `−1 − fee`. Same P&L identity as `gradeSimBet` / `netEvPerDollar`.
   **Unfilled bids contribute $0 staked** (no position) but ARE counted (fill rate is a headline diagnostic).

## 6. Metrics & the PRE-REGISTERED kill-criterion

Write the criterion **before** seeing the number (commit it in this doc + the module docstring; do not move it).

- **Primary (headline):** mean **fee-net EV per $1 of FILLED maker positions**, 95% bootstrap CI
  (`bootstrapMeanCi`, seed 42). **PASS = CI lower bound > 0**, on the cheap (<0.25) subset, **pooled across
  stations**, AND ≥2 stations individually CI-clear-0, AND not EHAM-only, AND holds across the entry-lead
  variants. Mirror `copyTradeVerdict`'s shape exactly.
- **Secondary:** low-variance `edge = won − p_rest` (`meanConfidenceInterval`); **fill rate** (filled / rested);
  **adverse-selection diagnostic** = hit rate on FILLED vs the counterfactual hit rate had ALL bids filled
  (filled-hit << all-filled-hit ⇒ adverse selection confirmed quantitatively); `Brier(ours) − Brier(market)` on
  the priced buckets (sanity vs KILL-GATE 2).
- **Operational margin:** as in copy-trade, a PASS that clears 0 but not a +2% EV/$1 margin is flagged
  `clearsMargin=false` (not worth live risk).
- **FAIL ⇒** maker entry on our forecast is also efficient → 4th angle falsified, **publish the measurement,
  rail stays DORMANT.** This is the expected branch.

## 7. Reuse map (exact symbols — do not reinvent)

- `gaussianBucketProbs(muNative, sigmaNative, buckets: BucketDef[])` → `number[]` — `distributions/gaussian.ts`.
- `EmosStation` (`blendedMu`, `sigma`, `fold`) + the forecast/obs/event/ladder loaders — fork from
  `scripts/research/db1-daybefore-efficiency.ts` (keep the `forkRmse` correctness accumulator).
- `BucketSnapshot`, `snapshotAtOrBefore`, `snapshotAtOrAfter`, `netEvPerDollar`, the `EvCi`/verdict shape —
  pattern from `sim/copy-trade.ts` (this module is its maker twin).
- `armEdgeStats` / `bootstrapMeanCi` / `meanConfidenceInterval` / `wilsonInterval` / `GradedBet` — `sim/stats.ts`.
- `takerFeeTotal` / `takerFeePerShare` — `fees.ts`. **Never** a bespoke fee.
- `parseConfigRows`, `toNative`, `fToC` — `packages/core/src/index.ts`.
- DB access: `makeScriptDb` / `loadEnv` / `listDatesISO` / `splitList` — `scripts/lib/*`.

## 8. Validation / acceptance criteria

1. `pnpm typecheck && pnpm test` green; new pure fns unit-tested, **deterministic** (seeded `mulberry32`),
   `[]`/NaN-safe on empty/junk input (the copy-trade idiom: pure + total, never throws on upstream drift).
2. **Fork-correctness:** the EMOS blend-μ RMSE byte-matches `db1`/`mos-pointskill` on the same window
   (≈1.2991°C) — proof the fork is the live model, not a re-derivation.
3. **Fill-model cross-validation against badatmath's OWN fills** (rigor anchor): we know badatmath's real fill
   prices+times (`wallet-forensics` / `/activity`). On the same buckets, check how often the snapshot-based fill
   model would have predicted badatmath got filled at its actual price — report the agreement rate as a
   model-trust diagnostic (it should be high; a low rate means the 30-min grid is too coarse and the result is
   caveated, not trusted).
4. **Honest coverage caveat**, surfaced in the report (copy-trade §11 precedent): the `market_snapshots` grid is
   ~30-min — coarser than intraday fill timing; the fill model is an approximation; state the fraction of cheap
   buckets with a usable entry book and a post-entry series.
5. Pre-registered kill-criterion stated before the run; verdict adjudicated by `makerSprayVerdict`; the live
   number is checked against it **without moving the threshold**.
6. CLI mirrors `db1` / `copytrade-feasibility`: `pnpm tsx scripts/research/maker-spray-feasibility.ts
   [--from] [--to] [--leads] [--stations] [--rest-at bid|bid+tick|ask-offset] [--entry-lead-h 43] [--cheap-max
   0.25] [--margin 0.02] [--json]`. Read-only; prints the readout + verdict + the by-product spray protocol.

## 9. Deliverable

The number + the verdict, in the WO-5 idiom: either "**maker entry on our forecast clears zero (CI [.. , ..]) —
4th angle OPEN, escalate to adversarial verification**" or (expected) "**maker entry is also efficient (CI
straddles 0); adverse selection confirmed (filled-hit << all-filled-hit); 4th and last angle falsified; live
rail stays DORMANT.**" Record it in `WALLET-RECON-HANDOFF.md` (new §12) + project memory. Ship nothing to prod.
```
PRE-REGISTERED KILL-CRITERION (frozen 2026-06-22, before any run):
  PASS = fee-net EV/$1 of FILLED cheap (<0.25) maker positions, 95% bootstrap CI lower bound > 0,
         pooled AND ≥2 stations clear 0 AND not EHAM-only AND stable across entry-lead variants.
  FAIL = CI straddles/below 0 → maker entry efficient on our forecast; 4th angle falsified; rail dormant.
```
