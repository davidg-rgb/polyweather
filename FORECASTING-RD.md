# Forecasting-skill R&D — log

> The market-beating lever per `DF5-FINDINGS.md` is forecasting **skill** (getting μ into the
> right bucket), not calibration. This log tracks the experiments against that, each a measured
> yes/no. Harness: `scripts/research/mos-pointskill.ts` (+ `.test.ts`). Started 2026-06-14 (iter-46).

## The instrument (read this first)

`mos-pointskill.ts` is an **offline, read-only, controlled walk-forward A/B** over the backfill
(`forecast_snapshots` slot `backfill` vs finalized `observations`). For each (station, model, lead)
it keeps a trailing `sigmaWindowDays` window and, building each target day on PRIOR data only,
computes the house blend μ under several arms that change **one variable at a time**, then scores
the **ladder-free point error in °C** (|μ − obs|, the direct proxy for *aim*).

Two deliberate design choices, both to dodge the overfit trap `DF5-FINDINGS` flagged for the
prior-σ lever:
- **Metric = point RMSE/MAE over the FULL backfill** (months × all covered stations), *not* Brier
  on the 30-day market window. Brier needs Polymarket ladders (30 days only, small, overfit-prone);
  point error needs only forecasts+obs (28 months, large-n). A μ-aim gain *must* show here first.
- **One variable per arm.** Probe #1 varies the per-model **correction** with blend weights held at
  the live inverse-MSE. Probe #2 varies the blend **weights** with the correction held at baseline.

`baseline` = the live model exactly (per-model `f − EMA_bias`, intercept only, slope ≡ 1; inverse-MSE
blend). Harness sanity: the baseline blend (lead-1 RMSE **1.33°C**) beats the best single model
(`icon_seamless` 1.46°C) — the blend works, so the comparison is trustworthy.

Run: `pnpm tsx scripts/research/mos-pointskill.ts --from 2025-01-01 --to 2026-06-12 --leads 1,2,3`
(45 stations, 8,775 blended build-days scored).

## Baseline (the number to beat)

| | lead 1 | lead 2 | lead 3 | overall |
|---|---|---|---|---|
| **blend μ RMSE (°C)** | 1.3325 | 1.5706 | 1.7660 | **1.5657** |
| blend μ MAE (°C) | 0.9898 | 1.1470 | 1.2937 | 1.1430 |

A ~1.3–1.6°C point RMSE against Polymarket buckets ~0.5–1°C wide IS the aim deficit in absolute
terms: μ is routinely 1–2 buckets off.

## Probe #1 — regression MOS (slope-free per-model correction). REJECTED.

Hypothesis: mean bias ≈ 0 with bad aim is the signature of **conditional/slope** bias; the live
intercept-only correction can't remove it; `obs = a + b·forecast` (OLS, b free) can.

| arm | overall RMSE Δ vs live |
|---|---|
| `mos` (OLS slope+intercept) | **−3.32%** (worse) |
| `mos_shrunk` (slope shrunk toward 1 by n/(n+10)) | −1.95% (worse) |

Uniform MOS makes the blend WORSE — but the per-model view explains why and is the real finding:

| model (lead 1) | `mos` Δ | model (lead 1) | `mos` Δ |
|---|---|---|---|
| **gfs_seamless** | **+3.84%** | **icon_seamless** | **−5.21%** |
| meteofrance | +1.83% | jma_seamless | −3.22% |
| ecmwf_ifs025 | +0.74% | ukmo_seamless | −2.47% |

MOS **helps the weak models** (gfs +3.8/+6.3/+5.1% across leads 1/2/3; the genuine slope error is
real) and **hurts the strong models** (icon −5.2/−4.6/−2.9%). But the inverse-MSE blend already
**down-weights gfs and up-weights icon** — so MOS improves exactly what the blend ignores and
degrades exactly what it leans on → net negative. `mos_shrunk` is uniformly less bad (small-window
overfit is part of the damage) but still loses. **The aim deficit is not per-model conditional bias.**

## Probe #2 — recency / concentration reweighting. REJECTED.

Hypothesis (DF5 lever 1, the tractable "recency" half): weight models by *recent* local skill, or
concentrate harder on the best, rather than a flat inverse-MSE window.

| arm | overall RMSE Δ vs live |
|---|---|
| `recency` (inverse-MSE on a 10-day half-life decayed window) | **−0.01%** (neutral) |
| `concentrate` (1/MSE² — sharper toward the best model) | −0.43% (worse) |

Both fail. Recency is a wash because the **skill ranking is stable** over the window (icon/ecmwf are
consistently best — recency just adds variance without signal). Concentration loses the blend's
**diversification** benefit. The live inverse-MSE blend is already near-optimal *for point error*.

## Conclusion so far

The two cheap, tunable levers — **post-processing the correction** and **reweighting the blend** —
are **exhausted**. They do not move μ-aim on large-n out-of-sample data. This sharpens `DF5-FINDINGS`:
the gap is not a knob on the existing pipeline; the inverse-MSE intercept-corrected blend sits at the
**point-skill ceiling of these inputs**. Consistent with DF-5: **ship no model change.**

## What's left (the structural levers — bigger, none disproven)

1. **Regime-conditional weighting** — the *untested* half of DF5 lever 1. Not recency, but
   conditioning weights on the synoptic regime (model-disagreement/spread bucket, season, or a
   pattern proxy): "which model is best *when the models disagree this much / in this season*." Needs
   a regime feature + per-regime fit + a hard overfit guard. **Next probe (#3).**
2. **The intraday nowcast beyond lead 0** — at lead 0 the running-max + climatological lift
   (`nowcast_lift`, ADR-15) is genuine non-NWP information. Its lead-0 aim contribution is unmeasured
   in isolation; and partial-day signal may help lead-1 late builds. Needs intraday replay data.
   **Probe #4.**
3. **Better inputs (DF5 lever 3)** — the likeliest real lever given #1/#2 of this log: a stronger
   deterministic source or station-level features (urban heat island, microclimate) the free NWP
   grid misses. This breaks the input ceiling rather than re-tuning under it.

Rejected, unchanged from DF-5: **blending the market price into the prior** (beats Brier-vs-market by
construction, defeats the thesis).

## Bottom line

Two levers measured and killed with large-n walk-forward evidence; the harness now makes every future
lever a fast yes/no. The market-beating path is **regime-conditional skill or better inputs**, not
tuning the blend. Do not promote (F-019); do not spend cycles on MOS or reweighting.

---

# Round 2 — handoff work-orders (`FORECASTING-RD-HANDOFF.md`)

Driven as the continuous loop (order L3-b → WO-3 → WO-4 → L3-a → L3-c). Each verdict committed.

## WO-L3-b — residual-structure diagnostic. VERDICT: NO exploitable structure → feature/MOS lever DEAD.

The decider: does the live blend residual `(μ − obs)` carry structure an observable feature could
explain? Script `scripts/research/l3b-residual-structure.ts` (+ `.test.ts`), walk-forward over the full
backfill, 45 stations, **8,775 builds**.

- **Residual: mean +0.025°C (≈0 → bias-corrected ✓), std 1.5655°C** (= the baseline blend RMSE — validates).
- **Per-feature Pearson |corr| with the residual — all tiny:** disagreement **0.0745** (strongest),
  anomaly 0.017, season_sin 0.005, season_cos 0.003, lead 0.004.
- **Multivariate in-sample R² of residual on ALL features: 0.60%** — and that is the *upper* bound on
  exploitable variance (OOS would be less).
- **Per-station residual means all ≈0** (−0.07…+0.17): the blend's per-station-per-model bias correction
  already works; no station-level bias survives. Residual std is per-station forecast difficulty
  (EHAM 0.85, KMIA 0.86 easy; KORD 2.04 hard) — irreducible, not bias.

**Verdict: the residual is effectively irreducible NWP error.** Any feature-based or MOS-style
correction is capped at <0.6% — DEAD (a third, independent confirmation of #1/#2). **Lever-3 therefore
means a genuinely BETTER SOURCE, not a feature** → L3-c is the live branch. Caveat for WO-3: regime
weighting reallocates weight by regime-specific *skill ranking* (a different mechanism than predicting
the residual from a regime feature), so it is still measured — but this result lowers its prior.

## WO-3 — regime-conditional weighting. VERDICT: REJECTED.

Script `scripts/research/wo3-regime-weighting.ts` (+ `.test.ts`). Per-(model, lead, regime) skill
windows; regime weights shrunk toward the global inverse-MSE by n/(n+12); correction held at baseline.
Walk-forward, 45 stations, 8,775 builds.

| regime arm | overall RMSE Δ vs live |
|---|---|
| `regime_season` (DJF/MAM/JJA/SON) | **−0.05%** (neutral) |
| `regime_disagreement` (rolling spread terciles) | **−0.02%** (neutral) |

Both neutral, far below the +1.5% bar; per-station deltas are tiny and mixed (KORD +0.08/+0.20%, KSEA
−0.29/0.00%, KSFO +0.15/−0.21%). **The model skill RANKING is regime-stable** — conditioning weights on
season or model-disagreement does not move μ-aim. This is the *fourth* independent confirmation (after
#1 MOS, #2 reweighting, L3-b structure) that the existing-NWP-input branch is exhausted.

## WO-4 — intraday nowcast beyond lead 0. VERDICT: real POINT-SKILL, but NOT a tradable edge.

> ⚠️ **CORRECTED by the Round-2 adversarial review (below).** WO-4 proves the nowcast beats *our NWP
> forecast*; it does NOT beat the *market*, which prices the same intraday METARs faster and more
> accurately. Read the "Round-2 review" section before acting on anything in this WO. The point-skill
> numbers below stand; the "the system's REAL edge is the late-day intraday signal" framing does NOT.

Script `scripts/research/wo4-nowcast-value.ts` (+ `.test.ts`). Data: `intraday_advances` (running max by
local hour) spans **182 days × 45 stations** — NOT blocked. Walk-forward: NWP lead-0 build μ (baseline
blend of lead-1 forecasts) vs the nowcast `running_max_h + median(obs − running_max_h)` (lift refit
walk-forward, no lookahead), by local hour, 9,486 (station,day,hour) samples. (`max_tenths_c` is a
misnomer — it stores °C; verified KORD 2026-06-01 h14 = 22.2 == 72°F.)

| local hour | NWP RMSE | nowcast RMSE (Δ%) | gate RMSE (Δ%) | oracle-min |
|---|---|---|---|---|
| 0–10 (morning) | ~1.17 | 2.0–4.2 (−75…−230%) | ~neutral | ~0.9–1.1 |
| 12 | 1.205 | 1.445 (−20%) | 1.122 (**+6.8%**) | 0.780 |
| 13 | 1.179 | 1.161 (+1.5%) | 0.991 (**+16.0%**) | 0.677 |
| 14 | 1.227 | 0.897 (+26.9%) | 0.915 (**+25.5%**) | 0.552 |
| 15 | 1.180 | **0.652 (+44.7%)** | 0.833 (**+29.4%**) | 0.428 |

**The same-day intraday running-max + lift nearly HALVES the point error vs the NWP blend by mid-afternoon.**
The `gate` variant — use the nowcast only when the running max already EXCEEDS μ_NWP (a hard, provable
"the day WILL beat the forecast" lower-bound) — is walk-forward-safe and positive from ~noon, reaching
+25–29% at h14–15. The morning hours are correctly negative (the running max is far from the daily max
and the lift is uncertain). oracle-min (per-sample best of NWP/nowcast, an unrealizable ceiling) shows
0.43°C at h15 — there is a lot of capturable value.

**This reframes the thesis.** DF-5 + probes #1–3 + L3-b proved the multi-day NWP blend is at its
point-skill ceiling and loses to market. WO-4 shows the system's REAL edge is the **late-day intraday
signal**, which the NWP path doesn't carry. The production lead-0 build already applies a running-max
constraint (ADR-15) — so this CONFIRMS that path is the valuable one and shows the value is strongly
**hour-dependent (concentrated after ~13:00 local)**.

### Productionization sketch (for operator review — NOT auto-shipped)

1. **Bet/build timing is the lever.** The nowcast edge at h15 (+45% point-skill) dwarfs h10 (−75%). The
   value is only capturable if the lead-0 build/bet runs at/after the local afternoon. Audit the 22Z
   slot's local-hour alignment per station; consider a late same-day build/bet pass closer to market
   close for stations whose afternoon lags 22Z. **This is the highest-leverage, lowest-risk change.**
2. **Sharpen the lead-0 distribution toward the nowcast at late hours.** The current
   `applyRunningMaxConstraint` may be too soft; the data says by h14–15 the nowcast should dominate the
   NWP prior. Re-evaluate the constraint's weight as a function of local hour.
3. **Refocus the market-beating R&D** from the NWP blend (dead end) to the late-day intraday capture +
   its timing. Re-run the 30-day market-overlap Brier with a late-hour, nowcast-weighted lead-0 build to
   see if THIS beats `market_consensus` where the NWP blend did not.

Caveat: this is point-RMSE; the Brier/edge-vs-market confirmation needs the 30-day market-overlap re-run
with a late-hour build. But the magnitude (NWP 1.18 → nowcast 0.65 at h15) is large and physical.

## WO-L3-a — blend the existing external sources. VERDICT: BLOCKED (data too thin).

`source_forecasts` depth: openweathermap 6 days (2026-06-13→18, 46 stations), weatherapi 4 days
(2026-06-13→16). They accrue ~1 day/day from the iter-39 cron, and most target dates aren't resolved yet.
Far below the ≥30-day walk-forward bar. **Revisit ≈ mid-July 2026** once ~30+ resolved days exist. (Lower
priority now — WO-4 shows the edge is the intraday signal, not a better multi-day blend member.)

## WO-L3-c — scout a better free deterministic source. SHORTLIST (not integrated).

From the vault free-API directory (`_public-apis/lookup.py weather|forecast`):
- **NWS — api.weather.gov (no-auth, HTTPS, CORS).** Human-augmented MOS point forecasts for US airports;
  daily max via the gridpoint endpoint. The best free "input the grid misses" for our ~12 US stations
  (KORD/KSEA/KSFO/KLAX/…). Top candidate.
- **Pirate Weather (no-auth, HTTPS).** Dark Sky-style global daily-high — a global secondary source.
- Already in system: OpenWeatherMap, WeatherAPI. Regional-only: Aemet (ES), HG Weather (BR), QWeather.
- AviationWeather/NOAA (no-auth) gives TAFs — station-level but aviation-shaped (not a clean daily tmax).

Vet ToS/coverage before any integration. Priority LOWERED by WO-4: a better source improves the lead-0
PRIOR the nowcast refines (could compound), but it is not the headline lever.

---

# Round 2 — conclusion

Five experiments, one winner. The multi-day NWP blend is a dead end for beating the market — **four
independent confirmations** (probe #1 MOS, #2 reweighting, L3-b residual-structure R²=0.6%, WO-3 regime)
that it sits at its point-skill ceiling. **The edge is the late-day intraday nowcast (WO-4):** the
running-max + lift nearly halves point error vs NWP by mid-afternoon (h15: 1.18 → 0.65°C, +45%; the
walk-forward gate +29%). The market-beating thesis should refocus from forecasting the day to **capturing
the day as it happens, late, and betting on it.**

**Ready for operator review.** Recommended, in priority order:
1. **Productionize WO-4** (sketch above): audit lead-0 build/bet TIMING vs local afternoon; sharpen the
   running-max constraint by local hour; then re-run the 30-day market-overlap Brier with a late-hour
   nowcast-weighted lead-0 build to test it against `market_consensus` directly. ← the live lever.
2. **Secondary:** revisit WO-L3-a (ext-source blend) + a possible NWS integration after ~30 days of
   source/obs accrual, to tighten the lead-0 prior the nowcast refines.
3. **Closed:** MOS, reweighting, regime weighting, feature-correction — do not revisit on the current
   NWP inputs.

---

# Round-2 review (adversarial) — CORRECTS the WO-4 trading claim

An independent adversarial audit (read-only) pressure-tested the round-2 findings, focused on WO-4 (the
one we'd act on). Verdict: **WO-4's methodology is SOUND but its trading framing is FALSIFIED.**

- **Methodology sound, no leakage.** Walk-forward ordering verified line-by-line (score-before-fold; lift
  from prior days only; M_h is legitimately same-day-observed; the gate uses only info available at hour h).
- **Unit assumption confirmed (not just one sample).** `intraday_advances.max_tenths_c` is °C: source is
  `metar.ts` (°C, may carry tenths) into a `numeric(4,1)` column; live range −23→41 over 19,287 rows;
  cross-checks against obs hold for both C- and F-unit stations. "Do not /10" is correct.
- **THE DISPOSITIVE FINDING — the nowcast does NOT beat the market.** WO-4 compared nowcast to *our pre-day
  NWP*, never to the market. The reviewer built the missing comparison from `market_snapshots` (234k
  intraday order-book mids, 88 resolved station-days), market-implied μ by station-local hour vs obs:

  | local hour | **market RMSE** | nowcast RMSE | NWP RMSE | oracle-min (unrealizable) |
  |---|---|---|---|---|
  | 13 | **0.68** | 1.16 | 1.18 | 0.68 |
  | 14 | **0.56** | 0.90 | 1.23 | 0.55 |
  | 15 | **0.40** | 0.65 | 1.18 | 0.43 |
  | 16 | **0.33** | — | — | — |

  By early afternoon **the market is more accurate than the nowcast and is essentially AT the oracle
  ceiling** — it has already priced the same running-max METARs (its participants observe them too).
  Arriving at h15 with a 0.65°C estimate to trade a 0.40°C market makes you the sucker, not the sharp.
- **Rejections (#1/#2/#3/L3-b) sound** — harness validated (blend 1.33 < icon 1.46), controlled-variable
  discipline genuine; the market comparison *reinforces* them (the NWP blend really is at its ceiling).
- **Sample caveat:** late hours have thinner intraday n (the `n<100` guard is on the pooled hour, not
  per-station), so the h15 point-skill magnitude could shift; the *market* comparison is robust across 88
  station-days. (Data-hygiene aside: a few obs rows are physically impossible — EPWA 88°C, KHOU 71°C — likely
  F-as-C corruption; negligible at large-n but worth a cleanup pass.)

## Revised conclusion (supersedes the Round-2 conclusion above)

The market-beating thesis is now **falsified on every signal we have**: the multi-day NWP blend is at its
ceiling (4 rejections), and the intraday nowcast — the one signal that beats our own forecast — is **already
priced by a faster, more accurate market**. On this evidence the market is **efficient with respect to both
NWP and intraday information** by mid-afternoon. The WO-4 productionization sketch (bet-timing, constraint
tuning) is **SUPERSEDED** — "build later" only helps if the market is *slower* than us at digesting METARs,
and the snapshot data says it is *faster*.

The single decisive question that remains (the only place a tradable edge could still live): **is the market
STALE in the minutes immediately after a new running-max METAR prints** — a latency window before it
reprices — that we could systematically trade? That is the recommended next step (WO-5 in the handoff). If
it is also negative, the honest conclusion is **no durable trading edge from these signals → pivot** (lean
on the analytics/insight value, or seek genuinely out-of-market information). Do not productionize WO-4 on
the current evidence.

---

# WO-5 — METAR-latency / market-staleness study. VERDICT: NO TRADABLE EDGE → trading thesis CLOSED.

> Script `scripts/research/wo5-market-staleness.ts` (+ `.test.ts`, 15 cases). Read-only. The decisive
> close-out from the handoff. Window 2026-05-13 → 2026-06-15 (the intraday × market_snapshots overlap):
> **756 station-days, 754 with a public running-max floor, 18,049 market polls (15,517 on a coherent book).**

**The airtight test — "dead mass".** A `highest` market resolves on the bucket containing the official
daily max, which is ALWAYS ≥ any individual METAR running max. So the instant a running max M becomes
public, every bucket whose whole labeled range is below M is **logically dead — P(win)=0, fair price 0.**
Any market price there is a provable mispricing. We reconstruct each market's full book at every poll
(forward-fill, because snapshots are delta-deduped) and sum the price on dead buckets:
- `mid` dead mass = gross (quoted midpoint), `bid` dead mass = **realizable** (what you could actually SELL into).
- Conditioned on **minutes since the new running max became public** — a latency window ⇒ elevated-fresh, decaying.

**Three data-truths that broke the handoff's stated assumptions (corrected in the script header):**
1. `intraday_advances.created_at` is the BACKFILL insert time, **not** the print time (95% of rows bulk-
   inserted 2026-06-12+; created_at spans 3 days, date_local ~182). Print-time proxy = `(date_local,
   local_hour)+tz` → **end of local hour H** (conservative: the H:51 METAR is definitely public by then).
2. `market_snapshots` are **delta-deduped** (a poll writes only changed buckets) → the book at time t needs
   a per-bucket forward-fill, not a group-by `captured_at`.
3. Timing resolution is **~1 h** (print side) / **~10 min** (snapshot side) → a sub-10-min latency window is
   **invisible here** — stated honestly, and it is also below our 5-min live reaction latency.

**Results (coherent books, sumMid≈1 — the market's real quoted state):**

| metric | mean | p50 | p90 | p99 | max | share > fee(0.05) |
|---|---|---|---|---|---|---|
| **mid** dead mass (gross) | 0.0125 | 0.0030 | 0.0310 | 0.1115 | 0.976 | — |
| **bid** dead mass (realizable) | 0.0056 | **0.0000** | 0.0160 | 0.0600 | 0.956 | **1.39%** |

The latency conditioning is **flat — no decay** (the decisive shape):

| minutes since new max | n | mid-mean | bid-mean | bid-p99 |
|---|---|---|---|---|
| [0,60) fresh ≤1h | 6321 | 0.0138 | 0.0060 | 0.0730 |
| [60,120) 1–2h | 2613 | 0.0128 | 0.0058 | 0.0630 |
| [120,360) 2–6h | 4161 | 0.0118 | 0.0056 | 0.0600 |
| [360,∞) ≥6h | 2422 | 0.0097 | 0.0039 | 0.0470 |

**Reading it:** the realizable (bid) dead mass median is **exactly 0** — the market gives you *nothing to sell
into* on logically-dead buckets — and only 1.39% of polls clear the fee on the bid. The residual ~1.3¢ of
gross *mid* dead mass does **not** decay with time-since-print (flat across all bins), so it is illiquid
leftover-quote noise, **not** a repricing lag. A latency edge would be fresh-elevated-then-decaying; it isn't.

**Why the coherence filter does NOT hide the edge (the obvious adversarial objection, pre-empted):** a market
that is *stale* — hasn't repriced after a print — is a **coherent** book (still sums to ~1, just at the old
distribution with dead buckets still priced high). I would catch that as a high-dead-mass coherent fresh poll
*with* a bid to sell into. The books I drop (sumMid∉[0.9,1.1]) are mid-*transition* reconstructions where the
favourite already updated to ~1 but the dead lows hadn't yet been written down to 0 — i.e. the market is
*already reacting*, and those dead lows carry **no bid** anyway (e.g. FACT 2026-05-19 raw dead mass 3.40,
best_bid null on all 10 dead buckets). Both the coherence filter and the bid metric independently kill the
phantom; the conclusion survives either lens.

**VERDICT: NO TRADABLE EDGE.** The market has already zeroed logically-dead buckets before our coarsest
observable instant, with no bid to hit and no latency structure. At ~1 h / ~10 min resolution the market is
**efficient with respect to the hard running-max floor.** Combined with the four rejected NWP levers and the
Round-2 finding that the market beats our nowcast on point error, **the trading thesis is closed on every
signal this system can see.** Any surviving edge lives in the sub-10-min window after a print — below both
this data's resolution and our live reaction latency — and even there carries no bid. **Pivot.**

**Pivot options for the operator (decision needed):**
- **(a) Lean on the analytics/insight value.** The system is a strong measurement instrument (calibrated
  ensemble, scored model-vs-market history, market-efficiency findings) even if not a profitable taker.
- **(b) Seek genuinely out-of-market information** — a paid/faster data feed or microclimate sensing that the
  crowd doesn't already price (the only thing that beats an efficient market is information it doesn't have).
- **(c) Shelve live trading.** Keep the pipeline warm; revisit only if market microstructure changes
  (illiquid new stations, a faster feed, or a sub-10-min execution path materialises).

**Data-hygiene micro-task (done):** exactly **2** physically-impossible `observations` rows exist — `EPWA
2024-12-16` tmax 88°C and `KHOU 2024-05-17` tmax_wu_native 160°F (=71°C); both `provenance='wu'`, no METAR
cross-check (`tmax_metar_tenths_c` null), both 2024 (outside the market window, so zero effect on WO-5, but
they pollute per-station tails). Proposed guard (staged for operator, not auto-applied — prod data):
`update observations set tmax_wu_native=null, divergence_flags = array_append(divergence_flags,'impossible_tmax')`
for those two ids, plus an ingest sanity check rejecting derived °C outside [−60, 55].

---

# MODEL-TRIM — per-city NWP model-set selection (the 5th point-skill lever). VERDICT: REJECTED (KILL). 2026-07-09.

> Full record: **`MODEL-TRIM.md`**. Script `scripts/research/model-trim.ts` (+ `.test.ts`, 17 cases). Read-only.
> The one point-skill lever the four rejections above never tested: not the per-model *correction* (Probe #1)
> or the *weighting scheme* (Probe #2 / WO-3) **over all models**, but hard per-city model **membership** —
> dropping the models that hurt a city. The operator asked for a full per-city model trim, iterated to plateau.

Same `mos-pointskill` walk-forward, extended to a **stitched forward test**: TRAIN = `backfill` (04-09→06-12),
TEST = live 22Z/10Z (06-13→now, real forward data the selection never saw). Baseline = the live all-8
inverse-MSE blend; arms change **only membership**. Per-city subset by bidirectional greedy stepwise on TRAIN.

**The honest OOS number (TRAIN-select → apply forward, no test-set reuse), pooled ΔMAE °C, 45 cities, city-clustered CI:**

| lead | Global trim ΔMAE | **Naive per-city ΔMAE [95% CI]** |
|---|---|---|
| 0 | −0.004 | **−0.016 [−0.044, +0.010]** |
| 1 | −0.002 | **−0.023 [−0.049, +0.002]** |
| 2 | +0.002 | **−0.024 [−0.050, +0.002]** |
| 3 |  0.000 | **−0.045 [−0.082, −0.012]** |

Per-city trimming is **negative at every lead** (lead-3 CI excludes 0 negative); global trim ≈ 0; stepwise
from-empty **re-adds all 8 models** (every bias-corrected member carries decorrelated signal). Robust across
inv-MSE/equal weighting × 22Z/10Z slots. Zero-skill null: naive selection (≈−0.02) beats *random* trimming
(≈−0.08) but not "keep everyone" (0).

**The trap it exposes (the value of the entry):** an adopt-or-shrink gate that *peeks at TEST* shows a
**+0.018 °C "PASS" with a CI excluding 0** — pure post-selection bias. The same selection, scored honestly,
is **−0.027 °C**. This is the project's prime lesson in miniature, and it reproduces + defuses the exact
`source-accuracy-findings.ts` multiple-comparisons false positive.

**VERDICT: keep the uniform full 8-model inverse-MSE blend for every city.** The blend is at its point-skill
ceiling; the accuracy lever is NOT model *selection* but **more/longer data + spread-conditional weighting +
ADDING decorrelated models + local predictors for the coastal/monsoon busts** (MODEL-TRIM.md §8). This makes
it **5 rejected point-skill levers** (Probe #1, Probe #2, WO-L3-b, WO-3, MODEL-TRIM).
