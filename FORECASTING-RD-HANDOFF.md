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

**ROUND-2 STATUS: COMPLETE + REVIEWED.** 4 rejected, WO-4 found real point-skill but the adversarial
review FALSIFIED its trading value (the market prices the intraday signal faster + more accurately — see
`FORECASTING-RD.md` "Round-2 review"). One decisive question remained → WO-5 below.

**WO-5 STATUS: ✅ DONE 2026-06-15 — NO TRADABLE EDGE → trading thesis CLOSED → PIVOT (operator decision).**
The market is efficient w.r.t. the hard running-max floor (754 station-days; realizable bid dead mass
median 0.0000; no latency decay). See `FORECASTING-RD.md` "WO-5" and the DONE banner on the WO-5 spec below.

---

# WO-5 — METAR-latency / market-staleness study. The decisive close-out. ✅ DONE 2026-06-15 → NO TRADABLE EDGE.

> **VERDICT: NO TRADABLE EDGE — the trading thesis is CLOSED on every signal this system can see.** The
> market is efficient w.r.t. the hard running-max floor (realizable bid dead mass median 0.0000; no latency
> decay; 754 station-days). Full writeup + tables: `FORECASTING-RD.md` "WO-5". Script
> `scripts/research/wo5-market-staleness.ts` (+`.test.ts`). Decision now belongs to the operator: PIVOT to
> (a) analytics-lean, (b) out-of-market information, or (c) shelve live trading. The spec below is retained
> for the record; the data-truth corrections it needed (created_at is backfill-time, snapshots are
> delta-deduped, ~1h/~10min resolution) are documented in the script header and the findings doc.

**Why this is THE next step.** The round-2 review showed the market is at the information ceiling by
mid-afternoon ON AVERAGE (market RMSE 0.40°C ≈ oracle 0.43°C at h15). But that average is over capture
times *within* each hour — it does NOT resolve the sub-hour dynamics right after a NEW running-max METAR
prints. The ONLY place a tradable edge could still live: a **latency window** in the minutes after a new
max prints, before the market reprices. If we can ingest the METAR and act faster than the market adjusts,
that gap is the edge. This experiment proves it exists or closes the trading thesis.

**Prior after the review: LOW (probably no edge).** Treat this as a close-out / falsification test, not a
hopeful build. Be ready for a negative result and the pivot it implies.

**Method (read-only, the data is all there):**
1. **New-max events.** From `intraday_advances`, a new-max event = a row where `max_tenths_c` (°C, NOT
   tenths — see the unit note) strictly exceeds the running max so far that day. `created_at` ≈ the poll/
   print time. ~19k advance rows over 182 days × 45 stations.
2. **Market trajectory around each event.** From `market_snapshots` (10-min cadence, ~234k rows, ~30-day
   overlap with intraday: 2026-05-14→06-14) build the market-implied μ (price-weighted bucket midpoint via
   `market_buckets` low/high) as a time series per event. Measure the market mid at t0 (the print), and at
   t0+10/20/30/60 min.
3. **The gap.** At t0, does the market mid already reflect the new max (i.e., is it ≥ the new running max,
   which is a hard floor on the day's tmax)? If the market mid implies a tmax BELOW the just-printed running
   max for several minutes, that is a provable, exploitable mispricing (the day cannot end below its current
   max). Quantify: frequency, magnitude (vs spread+fee from `market_buckets.fee_rate`), and persistence
   (how many minutes until the mid clears the new max).
4. **Tradability gate.** A positive result needs the gap to (a) exceed spread + taker fee, (b) persist
   longer than our reaction latency (poll cadence is 5 min live; snapshot resolution here is 10 min — so
   sub-10-min lags are invisible at this data granularity → state that ceiling honestly), and (c) recur
   often enough to matter. Report all three.

**Success / decision.** If a systematic, fee-clearing, multi-minute lag exists → the edge is latency
arbitrage on new-max prints; sketch the execution path (fast METAR ingest → immediate limit order above the
stale mid) for operator review, and flag the infra bar (sub-10-min reaction, liquidity, competing bots). If
NOT → the trading thesis is closed on these signals: **pivot.** Options to put to the operator: (a) lean on
the system's analytics/insight value (it's a good measurement instrument even if not a profitable trader),
(b) seek genuinely out-of-market information (a paid/faster data feed, microclimate sensors), or (c) shelve
live trading. Either way, log the verdict in `FORECASTING-RD.md` and update BUILD-STATE.

**Methodology contract:** same as the round-2 WOs (walk-forward where applicable, honest data-check first,
read-only, verdict-not-ship). Fork the harness only for the NWP μ if needed; most of this is direct
`market_snapshots` × `intraday_advances` time-series work.

**Parallel data-hygiene micro-task (cheap, do alongside):** a few `observations` rows are physically
impossible (EPWA tmax 88°C, KHOU 71°C — likely °F stored as °C). Find them (`select … where tmax_c > 55 or
tmax_c < -60`), confirm they're corrupt, and propose a fix/guard. Negligible for the large-n R&D but they
pollute per-station tails.
