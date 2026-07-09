# MODEL-TRIM — per-city NWP model-set selection

> **Verdict (2026-07-09): KILL — do not trim. Keep the full 8-model, per-station, bias-corrected,
> inverse-MSE blend for every city.** A hard per-city model subset, selected on TRAIN and applied
> honestly forward, makes the daily-Tmax forecast **worse** out-of-sample at every lead
> (naive OOS ΔMAE **−0.016 / −0.023 / −0.024 / −0.045 °C** at leads 0/1/2/3; the lead-3 CI excludes 0
> on the *negative* side). A global (one-set-for-all) trim does **nothing** (ΔMAE ≈ 0, CIs straddle 0).
> The stepwise selector, run from empty, **re-adds all 8 models** — every model, once bias-corrected,
> carries decorrelated signal, so the full ensemble is already at its point-skill ceiling. The
> apparent per-city "wins" (+0.017–0.042 °C) are a **multiple-comparisons / test-set-reuse mirage**:
> they exist only when the adoption gate is allowed to peek at the test window, and they flip negative
> the instant it can't. This reproduces and defuses the exact false-positive `source-accuracy-findings.ts`
> warned about. Robust across both weighting schemes (inv-MSE, equal) and both slots (10Z, 22Z).
> **Nothing shipped; read-only; no migration; no trade.**

- **Engine:** `scripts/research/model-trim.ts` (pure trim engine + walk-forward driver) + `.test.ts` (17 green).
- **Artifact:** `scripts/research/out/model-trim-{22Z,10Z}.csv` (per-city TRAIN-selected sets — the mirage, for audit).
- **Spine reused:** the `mos-pointskill.ts` walk-forward + `source-selector.ts` TRAIN→OOS→shrink discipline.

---

## 1. The question — the one point-skill lever never tested

The house point forecast (`house_gaussian` μ) is **already per-station in its corrections**: each of
the 8 core deterministic Open-Meteo models is EMA-bias-corrected (`correctPoint`, α=0.15) and
inverse-MSE-weighted (`computeModelWeights`) per `(icao, model, lead, slot)` in `model_stats`, over a
rolling 30-day window. But the model **set** is uniform — every city ingests the same enabled models;
a model is never *hard-dropped* for a city, only softly down-weighted by 1/MSE.

The four prior point-skill probes (`mos-pointskill` slope-MOS, `wo3-regime-weighting`, recency/concentrate
reweighting) all varied the *correction* or the *weighting scheme* — always over **all** models. **None
tested hard per-city subset selection.** That is this probe: *does dropping the models that hurt a given
city beat the all-models blend out-of-sample?* The operator asked for exactly this — a per-city trim,
iterated to plateau, "different cities may use different combos."

**Prior:** inverse-MSE weighting is already *soft* trimming, so a hard trim should buy little; and a
per-city best-of-2⁸ pick on ~40 days is a textbook multiple-comparisons false positive. The job is to
measure it honestly and say how much of any apparent gain is real.

---

## 2. Method — honest by construction

- **Panel (stitched walk-forward, the C24 stitch):** TRAIN = `backfill` slot (2026-04-09 → 06-12,
  ~68 days/city). TEST = a **live** slot (22Z or 10Z, 06-13 → today, ~24 days/city). TEST is real forward
  data the selection never saw — a native backtest-vs-forward cross-check. Truth = `observations.tmax_wu_native`
  (the market-resolution daily high; F-stations → °C). 45 cities, leads 0–3.
- **Baseline = the live model:** all 8 models, EMA-bias-corrected, inverse-MSE-weighted. Every arm changes
  **only the membership set** — the correction and weighting math are identical (apples-to-apples).
- **Selection:** bidirectional greedy **stepwise** on TRAIN point-RMSE — iterate single add/drop moves until
  none improves (the "iterate a few times until no further gain" loop), run from both the full set and empty,
  keep the lower. Per city, and once globally (pooled).
- **The load-bearing distinction — two ways to score the per-city trim OOS:**
  - **NAIVE (the honest number):** TRAIN-select → apply the *same* subset forward to TEST → pool. No gate,
    no test-set reuse. This is what you could actually deploy (select on the past, apply to the future).
  - **ADOPT-OR-SHRINK (optimistic):** the `source-selector.ts` posture — adopt a city's trim only if it beats
    the full blend *on TEST* by a margin, else shrink to the full blend. **Its gate reads TEST, then it is
    scored on TEST → post-selection bias.** Reported only as an upper bound, to expose the trap.
- **Uncertainty:** pooled ΔMAE with a **city-clustered bootstrap** CI (resample cities — N days on 45 cities
  is ~45 clusters, not N). **Zero-skill null:** how often a *random* subset of the same per-city size
  matches the naive gain (does TRAIN selection carry forward information at all?).

---

## 3. Results — trimming does not help; the honest number is negative

**Primary config (inverse-MSE, 22Z), pooled OOS ΔMAE in °C (positive = trim beats the full blend), 45 cities:**

| Lead | Baseline MAE / exact% | Global trim ΔMAE [95% CI] | **Naive per-city ΔMAE [95% CI]** | Adopt-shrink ΔMAE (peeks) |
|---|---|---|---|---|
| 0 | 0.799 / 33.9% | −0.004 [−0.013, +0.004] | **−0.016 [−0.044, +0.010]** | +0.018 [+0.007, +0.032] |
| 1 | 0.974 / 31.7% | −0.002 [−0.010, +0.006] | **−0.023 [−0.049, +0.002]** | +0.017 [+0.007, +0.028] |
| 2 | 1.091 / 28.4% | +0.002 [−0.010, +0.013] | **−0.024 [−0.050, +0.002]** | +0.020 [+0.008, +0.034] |
| 3 | 1.211 / 26.2% |  0.000 [ 0.000,  0.000] | **−0.045 [−0.082, −0.012]** | +0.018 [+0.008, +0.030] |

**Robustness — the sign of the honest number holds across schemes and slots** (naive per-city ΔMAE °C):

| Config | lead 0 | lead 1 | lead 2 | lead 3 |
|---|---|---|---|---|
| inv-MSE / 22Z | −0.016 | −0.023 | −0.024 | −0.045 |
| inv-MSE / 10Z | −0.029 | −0.029* | −0.032* | −0.048* |
| equal / 22Z | +0.010 | −0.005 | −0.011 | −0.036 |

`*` = 95% CI excludes 0 on the negative side (trimming robustly *worse*). Global trim ΔMAE ≈ 0 in every cell.
`zeroSkillPPass = 0%` everywhere: the naive selection (≈−0.02 °C) is *less bad* than random trimming
(mean random gain ≈ **−0.08 °C**) — TRAIN selection carries a little forward info, but not enough to beat
"keep everyone" (0). **The best move is not to trim.**

---

## 4. The centerpiece — the +0.018 → −0.027 sign flip *is* the trap

Look at the primary-config **complexity ladder** (mean OOS ΔMAE across leads):

```
rung 0 · all-8 inv-MSE blend (the live model):   baseline
rung 1 · global trim (one set, all cities):      −0.001 °C   (nothing)
rung 2 · per-city trim, NAIVE OOS (honest):      −0.027 °C   (worse)
rung 2*· per-city trim, adopt-or-shrink (peeks):  +0.018 °C   (mirage — not deployable)
```

The gate-based policy looks like a **+0.018 °C win with a CI that excludes 0** — a textbook "PASS." It is
an artifact: cities are *adopted because they beat the full blend on TEST*, and then measured on that same
TEST; shrunk cities contribute exactly 0. The pooled mean is mechanically ≥ 0. Remove the peek — select on
TRAIN, apply forward — and the *same* selection procedure yields **−0.027 °C**. This is the project's prime
lesson in miniature (`references/traps.md`): *a point estimate is a hypothesis; cross-check every backtest
against the honest forward number.* The +0.017–0.042 °C "adopted" gains in the CSV are winner's-curse upper
bounds, not deployable edges.

---

## 5. Why the full blend is already optimal — the per-model picture

Standalone raw (un-bias-corrected) skill over the panel, leads 0–3, all cities (n≈16k each):

| Model | MAE °C | RMSE °C | Bias °C |
|---|---|---|---|
| ICON | 1.379 | 1.873 | −0.56 |
| UKMO | 1.471 | 1.972 | −0.22 |
| GEM | 1.562 | 2.042 | −0.50 |
| ECMWF | 1.588 | 2.041 | −0.50 |
| Météo-France | 1.621 | 2.104 | −0.40 |
| GFS | 1.645 | 2.280 | −0.30 |
| CMA | 2.004 | 2.538 | −0.93 |
| JMA | 2.316 | 2.956 | **−1.66** |

Two things drive the KILL:

1. **Every model runs cold** (−0.2 to −1.66 °C) — a *universal* negative bias. That is the single biggest
   accuracy lever, and it is **already removed** by the per-model EMA bias correction. It is an *intercept*
   problem, not a *membership* problem.
2. **The bias-corrected 8-model blend (MAE ~0.97 at lead 1) beats the best single raw model (ICON, 1.38) by
   ~30%.** JMA looks droppable on raw error (worst, −1.66 cold), but bias-corrected it still adds decorrelated
   signal — which is exactly why the from-empty stepwise re-adds it. Ensemble averaging of decorrelated,
   bias-corrected members is the whole game; hard-dropping any member throws away signal.

---

## 6. The per-city answer the operator asked for

**"Different cities may utilize different model combos" → No.** At this data volume, the recommended model set
for **every** city is the **full 8-model inverse-MSE blend that is already deployed.** The per-city TRAIN-selected
sets (`out/model-trim-*.csv`) are not stable and do not transfer: a subset that wins in spring backfill loses in
summer live (regime shift is part of why naive selection is negative). Individually, no per-city CI is tight
enough at n≈22 test days to justify a deviation, and the pooled honest estimate is negative.

**Where the model actually struggles** (ECMWF standalone MAE, lead 1, hardest cities): **KLAX 4.3 °C**, Taipei
2.6, Chengdu 2.4, Kuala-Lumpur 2.4, Chongqing 2.3, Munich 2.3. These are coastal marine-layer / monsoon /
basin microclimates — the residual is a **physics/resolution** problem, not a model-*selection* problem. No
subset of the same 8 global models fixes a marine-layer bust. That is where the next accuracy investment goes
(§8), not into trimming.

---

## 7. Traps ruled out (`references/traps.md` checklist)

- **Out-of-sample:** TRAIN (backfill) and TEST (live forward) are disjoint by time; selection never sees TEST
  in the honest arm. ✔
- **Test-set reuse:** identified and quarantined — the gate-based number is labeled optimistic; the headline is
  the naive number. ✔ (this is the whole finding)
- **Clustering:** city-clustered bootstrap (45 clusters), not N-days-as-N. ✔
- **Selection on point estimate / winner's curse:** the adopt gate uses a margin; the honest verdict uses the
  naive forward number and a zero-skill random-subset null. ✔
- **Apples-to-apples:** only membership changes between baseline and trim; correction + weighting identical. ✔
- **Right estimator:** paired per-day MAE deltas → mean + clustered bootstrap; hit-rate → reported alongside. ✔
- **Robustness:** two schemes × two slots × four leads, all consistent. ✔

---

## 8. What additional data would actually improve the model (prioritized)

The trim is the wrong lever; here is where real point-skill gains live, in descending value-per-effort:

1. **Longer, multi-season forecast history — the #1 limiter.** `forecast_snapshots` spans only 2026-04-09 →
   now (~3 months, one season). The 30-day rolling calibration windows carry n≈8–27 residuals per cell → the
   bias/weight estimates are noisy, and *any* per-city or per-regime structure is un-estimable (it's why the
   selector overfits and the naive number is negative). **≥12 months** so the windows span seasons is the single
   highest-value investment; it would let every downstream lever below actually be fit. (Truth already goes back
   to 2024 — the gap is archived *forecasts*, backfillable from Open-Meteo's historical-forecast API.)
2. **Sub-degree, denser truth.** Truth is the **integer** WU native high, injecting ±0.5° quantization noise
   into every residual. `tmax_metar_tenths_c` is only ~11% covered and ERA5 is misaligned (MAE 5.3 °C). Filling
   METAR-tenths (and hourly obs, which `intraday_max` partly has) sharpens the error signal *and* unlocks
   diurnal/timing MOS.
3. **Ensemble-spread-conditional weighting.** `ensemble_snapshots` (ECMWF-ENS 51 + GEFS 30 members) already
   exists but feeds `house_ensemble`, **not** the μ blend's weights. Trust the blend more on low-spread days —
   a flow-dependent lever a static subset can never reach. Needs the member arrays wired into the point weighting.
4. **Add decorrelated models, don't subtract.** The finding is "more bias-corrected members help." So the lever
   is **ADD**: A/B `best_match` (Open-Meteo's meta-blend, live since 06-13) into the μ blend; add higher-res
   regional models where they exist (**HRRR/NBM** for US cities — `ncep_nbm_conus` is already seeded A/B-only;
   **ICON-D2/-EU** nests for Europe); revisit `kma_seamless` once its horizon is fixed.
5. **Local predictors for the hard cities (§6).** Elevation / coastal-distance station metadata, sea-surface-temp
   / marine-layer indices (check the free public-API catalog first), so the ~4 °C KLAX-class marine-layer and
   monsoon busts get a physical covariate instead of eight global models all missing the same way.
6. **Conditional-bias (slope) MOS, with more data.** `mos-pointskill` found slope-MOS didn't beat intercept-only
   *at this n*; the universal cold bias is intercept (handled), but per-city conditional bias (warm on hot days)
   needs item 1's longer record to fit without overfitting.

---

## 9. Reproduce

```bash
pnpm tsx scripts/research/model-trim.ts --leads 0,1,2,3 --slot 22Z            # primary (inv-MSE == live model)
pnpm tsx scripts/research/model-trim.ts --leads 0,1,2,3 --slot 10Z            # slot robustness
pnpm tsx scripts/research/model-trim.ts --leads 0,1,2,3 --slot 22Z --scheme equal  # weighting robustness
pnpm vitest run scripts/research/model-trim.test.ts                           # 17 tests
```

Deterministic (seeded bootstrap + null). Read-only: writes only `scripts/research/out/model-trim-*.csv`;
places no trade; touches no credentials; imports nothing from `packages/trading`.
