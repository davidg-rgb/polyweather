# SELECTOR-LEARNABILITY — REC-1 pre-registration (the decisive maker-path test)

> **What this is.** The pre-registered spec for **REC-1** (MAKER-REBATE-HANDOFF.md §4) — the one unrun
> lever that could turn the +EV *ceiling* (m6, +26%/$1 on badatmath's revealed picks) into a *capturable*
> edge. The question: **can WE independently pick which cheap (0.10–0.25) buckets to rest maker bids on —
> from features available BEFORE resolution — and reproduce out-of-sample the ~+3.9pp selection edge m6
> showed is achievable on his picks?** §12 already showed our-forecast selection FAILS (−1.7pp) and
> indiscriminate selection FAILS (−1.5pp). REC-1 asks whether a *learned* selector over a richer pre-entry
> feature set does better — tested honestly, out-of-sample.
>
> **Posture: analytics study, NOT a trading green-light.** Ships nothing to prod, no migration, no live
> rail, never imports `packages/trading`. Read-only. The deliverable is the verdict either way. The live
> rail stays **DORMANT** unless this PASSES *and* execution realism (REC-2) is then shown viable.
>
> **WO-5 discipline:** the kill-criterion below is FROZEN before any model run. Do not move it to fit a number.

---

## 0. The binding data finding (established before modelling, `_rec1-probe`)

The cheap-eligible maker universe — a (resolved bucket × event) with a rested price `< 0.25` from the entry
book **and** a post-entry `market_snapshots` series — is **1,024 candidates (991 fillable), but spread over
only FOUR distinct weather-days: 2026-06-12, -13, -14, -15.** This holds at *every* entry lead (6/12/24/36/48h);
shortening the lead changes the row count, never the day count. The cause is book density: `market_snapshots`
does not cover the 24–48h pre-resolution window on any other days yet (the §15/badatmath note: "dense only ~Jun 8+").
This matches §12's corrected n≈995 — the same 4-day base.

**Why this dominates the design.** A weather-day is the unit of *independence*: all ~300 cheap buckets on
June 14 share one synoptic state, so their win/loss outcomes are massively cross-correlated. The effective
independent sample for any *selection* claim is the number of **day-clusters (4)**, not the 991 buckets. A
learned selector also needs days to *train* on and *test* on (it must generalise across independent weather
states, not within one). Four clusters is below the floor for either. Therefore:

- The honest confidence interval is a **day-cluster bootstrap** (resample whole days), not a per-bucket bootstrap.
- The honest OOS test is **leave-one-day-out** (train on the other days, predict the held-out day) — the
  small-sample form of walk-forward; strict forward-only is impossible with 4 days.
- The verdict carries a pre-registered **data-sufficiency gate**: below `MIN_CLUSTERS` independent days the
  result is `INSUFFICIENT_DATA` regardless of the point estimate — you cannot validate a selector on 4 days.

This is not a reason to skip REC-1 — it is the reason to build it so the answer is honest *now* and the same
harness re-runs decisively once book density grows (REC-3 ingest + REC-4 monitor → more days).

## 0a. Calibration amendment (the gate CI — decided BEFORE the real run, by H0 simulation)

The original gate (§8) said "day-cluster bootstrap CI lower bound > 0". In pre-run simulation a **percentile
cluster bootstrap was measured ANTI-CONSERVATIVE at few clusters** — its H0 false-positive rate was 7.5–12.5%
at 12 clusters (the point estimate is unbiased, but the interval is too narrow when only a handful of
independent clusters exist). The gate CI is therefore the textbook clustered-inference interval instead: collapse
each weather-day to its mean edge, then **mean ± t_{K−1}·SD/√K over the K cluster means** (equal-weight clusters;
t naturally explodes the interval for small K). Pre-run H0 simulation of this `clusterMeanTCi`: false-positive
rate ≈ **0%** at K∈{8,12,20}; power ≈ **73–90%** for a strong signal (effect 0.5) at K∈{10,12}. This change was
made by calibrating the FALSE-POSITIVE control on simulated H0 data **before** the real run (proper
pre-registration discipline, WO-5) — NOT by fitting to the real outcome (unseen at the time). MIN_CLUSTERS stays
8 (now defensible — the t-interval is honest there). The percentile bootstrap was dropped.

---

## 1. Goal (one sentence)

A pure, deterministic, read-only harness that trains an **L2-regularised logistic selector** on a frozen set of
**pre-entry features**, scores the resulting cheap-bucket maker selection **out-of-sample** (leave-one-day-out)
with **day-cluster** confidence intervals and a **zero-skill calibration-null**, and adjudicates a
**pre-registered** kill-criterion — answering whether badatmath's selection is *learnable by us* or his alone.

## 2. The question, precisely (why this is not a re-run of §12 / m6)

- **§12 maker-spray** rested on OUR-forecast-selected (`calibratedP > restPx`) or indiscriminate cheap buckets →
  both **FAIL** (−1.7pp / −1.5pp). One signal (the EMOS prob), used as a one-feature threshold.
- **m6 selection-mirror** rested on HIS REVEALED picks → **+3.9pp ceiling** — but that requires *seeing his picks*
  (latency wall, §11) and *is* his edge.
- **REC-1 (this):** can a selector trained on **microstructure + our forecast + price-action** features pick the
  same kind of buckets *independently*, and hold up *out-of-sample*? Different, untested. Honest prior: **guarded**
  (our forecast already failed at selection; but a multi-feature learned selector is a distinct approach).

## 3. Scope / non-goals (hard boundaries)

**In scope (read-only):**
- New pure module `packages/core/src/sim/selector-learn.ts` (+ `selector-learn.test.ts`).
- New research script `scripts/research/m7-selector-learnability.ts` — reuses the **maker-spray** loaders +
  `makerEntry`; does not edit the shared `db1`/`mos-pointskill`/`maker-spray` harness.
- Reuse, never reimplement: `makerEntry` / `makerNetEvPerDollar` (`sim/maker-spray.ts`), `meanConfidenceInterval`
  / `bootstrapMeanCi` (`sim/stats.ts`), `mulberry32` (`calibration/scores.ts`), the EMOS spine + loaders forked
  in `maker-spray-feasibility.ts`.

**Out of scope (do NOT touch):** `packages/trading/**`; any migration / table / Edge Function / cron / web
surface; the live model; any prod write. No new third-party dependency (the logistic regression is hand-rolled,
dependency-free, deterministic).

## 4. Inputs (all already in the DB — via the maker-spray spine)

| Need | Source |
|---|---|
| Walk-forward EMOS μ,σ → `calibratedP` per cheap bucket | `forecast_snapshots`(backfill) + finalized `observations`, via `loadEmosInputs`/`assembleBids` |
| Resolved bucket markets + ladders + tz + fee/tick | `market_events` + `market_buckets`, via `loadEvents` |
| Entry book + post-entry series per bucket | `market_snapshots`, via `loadBucketSeries` (tz-correct window) |
| The rested price + eligibility + outcome | `makerEntry` (the §12 owner of entry-snapshot resolution + fill) |

## 5. The frozen FEATURE SET (pre-registered — no subset sweep, so no FDR needed)

All computed from the entry snapshot and snapshots **at or before** the entry instant — **zero post-entry
leakage** (the fill outcome the model is graded on is never an input):

1. `calibratedP` — our EMOS calibrated bucket probability.
2. `restPx` — the rested price (entry best-bid, tick-floored) = the bar to beat.
3. `edgeP = calibratedP − restPx` — our model-implied edge (the db1 signal).
4. `spread = ask − bid` at the entry snapshot — book tightness.
5. `restVsMid = restPx − mid` at entry — how far below mid we rest (passivity).
6. `drift = mid(entry) − mid(earliest pre-entry snapshot in window)` — recent price momentum into entry.

Model: standardise features on the **training** folds only, fit L2-regularised logistic regression of `won`
on the features, predict `pWin`. **Selection rule:** rest iff `pWin > restPx` (we judge the bucket underpriced).
The selection edge `won − restPx` over the selected set is the binding metric (rebate-independent, low-variance);
the maker fee-net EV/$1 (conservative rebate 0 and realistic `weather_fees` rebateRate 0.25) is reported alongside.

## 6. Protocol

- **In-sample ceiling** (optimistic upper bound): fit on ALL days, select, score. If even this does not clear, OOS cannot.
- **Leave-one-day-out OOS** (the honest test): for each day `c`, train on the other days, predict `c`, select, pool.
- **CIs:** report both a **per-bucket** bootstrap (optimistic) and a **day-cluster** bootstrap (honest, the gate).
- **Zero-skill calibration-null:** draw each pick's outcome `won_i ~ Bernoulli(restPx_i)` (a perfectly-calibrated
  market, true edge 0), re-run the WHOLE pipeline (fit → select → edge), count P(day-cluster edge CI lower bound > 0).
  Measures how often the selector manufactures spurious edge from noise. MUST be `< 5%` to trust a PASS.

## 7. Validation / acceptance

1. `pnpm typecheck && pnpm test` green; new pure fns unit-tested, deterministic (seeded), `[]`/NaN-safe.
2. No post-entry leakage (features use only ≤ entry snapshots) — asserted in the spine + a test.
3. Pre-registered kill-criterion stated before the run; adjudicated by `selectorVerdict` without moving thresholds.
4. CLI mirrors the research idiom: `pnpm tsx scripts/research/m7-selector-learnability.ts [--from] [--to]
   [--leads] [--stations] [--entry-lead-h] [--lookback-days] [--cheap-max] [--l2] [--mc-iters] [--json]`.

## 8. The PRE-REGISTERED kill-criterion (frozen 2026-06-23, before any run — do NOT move)

```
FROZEN (selector-learn.ts SELECTOR_LEARN config):
  cheap cut:        restPx in [0.10, 0.25)   (the §15 engine band)
  selection rule:   rest iff pWin > restPx    (model judges the bucket underpriced)
  binding metric:   OOS (leave-one-day-out) selection edge (won − restPx), DAY-CLUSTER bootstrap CI
  MIN_CLUSTERS = 8: below 8 independent weather-days → INSUFFICIENT_DATA (cannot validate a learned
                    selector; today's 4 days is far below this — the verdict is data-limited, not a clean PASS/FAIL)

  PASS  = nClusters ≥ MIN_CLUSTERS
          AND OOS day-cluster selection-edge 95% CI lower bound > 0
          AND zero-skill P(PASS) < 5%
          AND the in-sample ceiling edge > 0 (necessary precondition)
        → a genuinely capturable selector candidate. ESCALATE to adversarial re-verification, THEN REC-2
          (execution realism: queue competition + lagged visibility) before any thought of the dormant rail.

  INSUFFICIENT_DATA = nClusters < MIN_CLUSTERS
        → the data cannot answer REC-1. The in-sample ceiling + null are reported as supporting evidence
          of how overfit-prone the thin base is. Unblock = book density (REC-3 ingest, REC-4 monitor) → more
          days; re-run this same harness when nClusters ≥ MIN_CLUSTERS. Rail stays DORMANT.

  FAIL  = nClusters ≥ MIN_CLUSTERS but the OOS CI straddles/below 0, OR zero-skill P(PASS) ≥ 5%
        → his selection is NOT learnable by us out-of-sample (REC-6, the honest kill). Record as the next
          falsified angle in FINDINGS.md. Rail stays DORMANT.
```

## 9. Deliverable

The verdict in the WO-5 idiom, recorded in `MAKER-REBATE-HANDOFF.md` / `FINDINGS.md` + project memory:
either "**learnable — OOS day-cluster edge clears 0, null quiet → REC-2**", or "**not learnable (FAIL/REC-6)**",
or (expected, given §0) "**INSUFFICIENT_DATA — only 4 independent weather-days; re-run when density grows**".
Ship nothing to prod.

---

## 10. RESULT (run 2026-06-23 — `m7-selector-learnability.ts`, window 2026-04-21→06-21, leads 1,2, entry-lead 24h)

**Verdict: `INSUFFICIENT_DATA` — and the available signal leans NOT-LEARNABLE.** The expected branch (§0) fired,
with corroborating overfitting evidence.

| | n (selected) | clusters | selection edge — cluster-t 95% CI (GATE) | per-bucket edge | realistic maker EV/$1 |
|---|--:|--:|--:|--:|--:|
| **In-sample ceiling** (fit+score all) | 50 | 4 | **+13.63pp** [−13.72, +40.99] | +10.63pp [−2.55, +23.81] | +65.8% [−65, +197] |
| **Out-of-sample** (leave-one-day-out) | 59 | 4 | **−9.66pp** [−27.56, +8.24] | −5.73pp [−14.62, +3.15] | −46.4% [−147, +54] |

- **Universe:** 45 stations · 721 resolved events · 5,203 bids → **202 cheap-band [0.10,0.25) picks** over **4
  weather-days** (Jun 12/13/14/15: 22/57/60/63). Fork EMOS blend-μ RMSE **1.2992°C** ≈ the documented 1.2991 →
  the spine is the live model (same loaders as §12).
- **The decisive read — overfitting.** The in-sample ceiling looks promising (+10.6pp) but the OOS edge
  **collapses to −5.7pp** (cluster-t −9.7pp): the 6-feature learned selector fits in-sample noise and does NOT
  generalise across weather-days. This extends §12 (one-feature forecast selection, −1.7pp) to a richer learned
  selector — same wall, larger model. The zero-skill null was quiet (2.0% < 5%), so the gate's other arms were
  honest; the binding blocker is the cluster count.
- **Verdict logic:** 4 clusters < MIN_CLUSTERS 8 → `INSUFFICIENT_DATA` regardless of the point estimate (you
  cannot validate a learned selector on 4 independent days). The OOS-negative point estimate is reported as
  supporting evidence, not a clean FAIL.
- **So:** the maker-selection lever is **un-answerable on today's data** (a book-density blocker, REC-3/REC-4 →
  more days), and what signal exists points AWAY from a capturable edge. The **live rail stays DORMANT.** Re-run
  this exact harness when `nClusters ≥ 8`. If the OOS edge stays negative as days accumulate, this converges to
  REC-6 (the honest kill); a clean PASS would require the OOS cluster-t CI to clear 0 with the null < 5%.
