# Forecasting-skill R&D — execution handoff (3 open work-orders)

> Continues `FORECASTING-RD.md`. Probes #1 (regression MOS) and #2 (recency/concentration
> reweighting) are DONE + REJECTED — the cheap, tunable levers are exhausted; the live
> inverse-MSE intercept-corrected blend is at the point-skill ceiling of the current NWP inputs.
> Three structural levers remain, none disproven. This file specs them as independent,
> runnable work-orders. Each ends "ready for review" — a measured verdict, NOT a shipped model
> change (per DF-5 / F-019: no model change ships without operator review).
>
> Harness: `scripts/research/mos-pointskill.ts` (read-only walk-forward A/B; exports `olsFit`,
> `shrinkFit`, `runMosExperiment`). Baseline to beat: blended point RMSE **1.5657°C overall**
> (lead-1 1.3325, lead-2 1.5706, lead-3 1.7660), 45 stations, 8,775 build-days.

## Status board

| WO | Lever | Data-ready NOW? | Effort | Verdict |
|----|-------|-----------------|--------|---------|
| **WO-3** | Regime-conditional weighting | ✅ YES | M | ❌ REJECTED (season −0.05%, disagreement −0.02%; skill ranking regime-stable) |
| **WO-4** | Intraday nowcast beyond lead 0 | ✅ YES (182d×45st, not thin) | M | ✅ **WORKS** (h15: NWP 1.18→0.65°C +45%; gate +29%) — the live lever |
| **WO-L3** | Better inputs | ◑ PARTIAL | L | L3-b ❌ no structure (R²0.6%) · L3-a ⛔ BLOCKED (data thin) · L3-c 📋 shortlist (NWS, Pirate) |

**Round-2 complete — see `FORECASTING-RD.md` "Round 2". Headline: the market-beating edge is the
late-day intraday nowcast (WO-4), not the NWP blend (4 independent rejections). Ready for review.**

## Methodology contract — EVERY work-order MUST obey (these are why #1/#2 are trustworthy)

1. **Use the harness pattern.** Fork `scripts/research/mos-pointskill.ts` into your own script
   (`scripts/research/<wo>.ts`) — do NOT edit the shared harness in place (parallel-safety). Reuse
   its data-loading, `StationModel` window discipline, and pure helpers.
2. **Walk-forward only.** Fit every stat on data with `target < build day`. No peeking. (The harness
   already does this; preserve it.)
3. **One variable per arm.** Change exactly one thing vs `baseline` (which must reproduce the LIVE
   model: per-model `f − EMA_bias`, inverse-MSE blend). If `baseline` in your fork doesn't match the
   harness's baseline RMSE (1.5657 overall), your fork is wrong — fix before trusting any arm.
4. **Metric = ladder-free point RMSE/MAE in °C over the FULL backfill**, leads 1–3, ≥30 stations.
   NOT Brier on the 30-day market window (small, overfit-prone — the trap DF-5 flagged). A μ-aim gain
   must show in point error first.
5. **Guard overfit, hard.** Any conditioning (regime, feature, extra input) must: require n ≥
   `sigmaMinN` per stratum or fall back to the global estimate; shrink toward the global/no-op prior;
   and be reported per-lead AND per-station (a lever that only helps one station is noise).
6. **Success bar.** A lever "works" only if it cuts blended point RMSE by **≥1.5% overall**, the gain
   holds across all three leads, and it's positive on a majority of the ≥minPairs stations. Anything
   smaller is in the noise of a 30-day-equivalent OOS sample — treat as REJECTED (cf. #2's −0.01%).
7. **Honest data check FIRST.** If the data a WO needs is too thin to measure, the deliverable is the
   documented data-availability finding + "BLOCKED on <data>", NOT a fabricated or low-n result.
8. **Ready for review = a verdict logged + committed.** Append a dated section to `FORECASTING-RD.md`
   (works/doesn't, with the number table). If it WORKS, add a productionization sketch (how to wire it
   into `run-calibration`'s `model_stats` fold + `functions/_shared/distributions.ts`) — but DO NOT
   ship a prod model change; that's the operator's review call.

---

## WO-3 — Regime-conditional weighting  ·  data-ready ✅

**Hypothesis.** Model skill depends on the synoptic regime; weighting each model by its skill *within
the current regime* beats flat inverse-MSE. (This is the UNtested half of DF-5 lever 1 — #2 tested
recency and failed; this tests regime, which recency is not a proxy for.)

**Method.** Fork the harness. Add per-`(model, lead, regime)` MSE windows alongside the global one.
At build time, classify the day's regime, look up regime-specific inverse-MSE weights (fall back to
global when that regime has < `sigmaMinN` samples), blend baseline-corrected points, score point RMSE.
Test these regime definitions as separate arms (each vs `baseline`):
- `disagreement` — tercile of the day's cross-model spread (std of the raw model points). The
  intuition with the most physical basis: when models diverge, the historically-best-in-divergence
  model should get more weight than its flat-window skill implies.
- `season` — meteorological season from month (DJF/MAM/JJA/SON).
- `anomaly` — tercile of the blend forecast vs the station's day-of-year climatological mean
  (cold / normal / hot days), computed walk-forward from prior obs.

Shrink regime weights toward the global weights by `n_regime / (n_regime + k)` to control overfit.

**Success.** Per the contract (#6). Report all three regime arms; the disagreement arm is the primary.

**Ready for review.** `FORECASTING-RD.md` "Probe #3" section: per-arm RMSE table (overall + per lead),
per-station spread, verdict. If any arm works → sketch wiring regime into `model_stats`
(add a `regime` dimension to the calibration fold) + the build path's weight lookup.

---

## WO-4 — Intraday nowcast beyond lead 0  ·  CHECK DATA FIRST ⚠️

**Hypothesis.** At lead 0 the observed partial-day running max + climatological lift (`nowcast_lift`,
ADR-15; `applyRunningMaxConstraint`) is genuine non-NWP information. Its standalone aim contribution is
unmeasured; it may also help late lead-1 builds.

**STEP 0 — data availability (do this before anything; the probe may be BLOCKED).** Run:
```sql
select 'intraday_advances' t, count(*) n, count(distinct icao) icaos, min(date_local), max(date_local) from intraday_advances
union all select 'intraday_max', count(*), count(distinct icao), min(date_local), max(date_local) from intraday_max
union all select 'nowcast_lift', count(*), count(distinct icao), null, null from nowcast_lift;
```
Intraday is captured LIVE (metar-nowcast every 15 min), not deeply backfilled — so history is likely
days/weeks, not months. If `intraday_advances` spans < ~30 days × < ~10 stations, the walk-forward
measurement is too thin: log "BLOCKED — intraday history accrues forward from <date>; revisit after
N weeks of live capture" and stop. Do NOT fabricate a result.

**Method (if data sufficient).** For lead-0 events with intraday coverage at the build hour, compare
two distributions vs realized truth: (a) NWP-only `house_gaussian`, (b) the `applyRunningMaxConstraint`
nowcast-constrained version. Score point error (use the distribution mean) AND Brier on the real ladder
(lead-0 events have Polymarket buckets). Quantify the nowcast's standalone lift by local hour.

**Success / review.** If the nowcast meaningfully beats NWP-only at lead 0 → it's already wired in
production for lead 0; the finding would justify EXTENDING it (e.g., a partial-day constraint at late
lead-1). Log verdict + the by-hour lift curve.

---

## WO-L3 — Better inputs  ·  PARTIAL ◑ (the likeliest real lever; biggest effort)

**Hypothesis.** The free NWP blend has a point-skill ceiling (#1/#2 strongly imply it); a stronger
input or a station-level feature the grid misses breaks it. Three sub-tasks, increasing ambition:

**L3-a — blend the existing external sources (data-limited; check first).** OWM + WeatherAPI already
flow into `source_forecasts` (snapshot-sources, iter-38/39). Check history depth:
```sql
select source, count(*) n, count(distinct icao) icaos, min(target_date), max(target_date)
from source_forecasts group by source;
```
These accrue FORWARD from ~2026-06-13, so history is thin (days). If too thin for walk-forward, log
BLOCKED + revisit date. If/when sufficient: add each source as an extra blend member (same bias/weight
treatment) and measure whether the blended RMSE drops. (Today: likely BLOCKED — say so.)

**L3-b — residual-structure diagnostic (data-ready NOW; do this one first).** This decides whether
better inputs/features even CAN help. Regress the live blend residual `(μ − obs)` on candidate features
— month, day-of-year `sin/cos`, forecast level, cross-model spread, station — over the full backfill,
walk-forward. If the residual has **no exploitable structure** (near-zero R²), the ceiling is
irreducible NWP error and lever 3 means a genuinely better *source*, not a feature. If structure
exists, it names the feature to add. Cheap, high-information — run it regardless.

**L3-c — scout a better free source (research).** Per the vault standing rule, check the free-API
directory: `python "04 Information Databank/AI & Engineering/_public-apis/lookup.py" weather`. Identify
any free deterministic source with skill plausibly beyond Open-Meteo's blend (vet auth/ToS/HTTPS).
Output: a shortlist + recommendation, NOT an integration.

**Success / review.** L3-b verdict (is there exploitable residual structure?) drives the rest. Log all
sub-task findings; if a source/feature shows promise, sketch the ingestion + blend-member wiring.

---

## How to run these

Both modes are supported. Each WO writes to its OWN script + its OWN `FORECASTING-RD.md` subsection,
so they don't collide on code — but they DO append to the same findings doc.

- **Continuous loop (RECOMMENDED).** Run WOs sequentially, one per iteration, in this order:
  **L3-b → WO-3 → WO-4 → L3-a → L3-c**. Rationale: L3-b's residual-structure result tells you whether
  ANY input/feature lever can work (informs WO-3 and L3); WO-3 is the richest data-ready lever; WO-4
  and L3-a gate on data checks. Sequential = zero merge conflict on `FORECASTING-RD.md`; each iteration
  commits its verdict. Stop when all three WOs have a logged verdict (Definition of Done below).
- **Parallel workflows (faster, more setup).** Run WO-3, WO-4, WO-L3 as three agents with
  `isolation: 'worktree'` (each gets its own checkout → no file races). Each writes a SEPARATE findings
  file (`FORECASTING-RD-wo3.md` etc.); a final consolidation step merges them into `FORECASTING-RD.md`.
  Use this only if wall-clock matters more than the merge step.

Recommendation: the **loop** — the WOs inform each other (L3-b first), the data-check gates want a human
glance, and sequential keeps `FORECASTING-RD.md` clean.

## Definition of done (the loop's stop condition)

All three work-orders have a dated verdict in `FORECASTING-RD.md`:
- WO-3: regime arms measured, verdict (works ≥1.5% / rejected). If works → productionization sketch.
- WO-4: data check logged; either a measured nowcast-lift verdict OR "BLOCKED on intraday history".
- WO-L3: L3-b residual-structure verdict (the key one) + L3-a data check + L3-c source shortlist.

Each verdict committed. Any lever that clears the success bar carries a productionization proposal —
**staged for operator review, not shipped** (DF-5 / F-019). Then ping the operator: "forecasting-skill
R&D round 2 complete — N/3 levers measured, M promising, ready for review."
