# INTRADAY-CONVERGENCE — when do forecasts lock in, ours vs the market vs the floor (CITY-ORACLE-BUILDOUT Build 3)

> **2026-07-26.** With the resolution path known (the METAR stream, `docs/DATA-SOURCES.md`
> §resolution-oracle), this build scores WHEN the outcome locks in, hour by hour along each
> resolution day: our house distribution's Brier vs the eventual winner, against the market's
> implied-distribution Brier, against a floor-only baseline. **Descriptive analytics — no signal
> claim, no trading implication; the twelve-signal verdict stands (`FINDINGS.md`).** This is the
> quantified version of the closed thesis's second leg: *the intraday nowcast is already priced by a
> faster market* — now with numbers per city.

## The three instruments

| curve | what it is | data | basis |
|---|---|---|---|
| **HOUSE** | our `house_gaussian` distribution (nowcast rebuilds included — the running-max-constrained build), latest available at each hour | `bucket_probabilities` (10Z/22Z + intraday rebuilds at every UTC hour, live since 2026-06-13) | model probs |
| **MARKET** | normalized per-bucket mid levels from the trade-print archive | `out/market-history/` (fidelity ≤10 min; July re-pull 2026-07-26, 933 events) | ⚠ trade-print MIDs (trap #1/#8) — scoring only, nothing here is executable |
| **FLOOR** | zero-model baseline: uniform over buckets still alive under the IEM METAR rendered running max | `out/iem-asos-archive/` (§resolution-oracle rendering) | resolution-grade obs |

Scoring: multi-bucket Brier vs the resolved winner at each station-local hour 6..23 of the
resolution day. **Lock-in hour** = first hour whose Brier stays ≤ 0.1 through end of day.
Ghost-quote law on all market level reads (print within 60 min required; an event-hour needs ≥ half
its ladder fresh). Panels: HOUSE = 1,853 mismatch-free graded events (DB); MARKET/FLOOR = 1,779
archive-joined city-days; **window 2026-06-13 .. 2026-07-24, 45 cities** (lucknow n=27 — thin
listings). The two panels overlap heavily but are not identical event sets — this is a descriptive
read, not a matched-pairs test.

## Headline: the three lock-in hours

| curve | pooled median Brier 06 → 12 → 16 → 20 → 23 local | lock-in (median, share of days locked by day end) |
|---|---|---|
| **MARKET** | 0.62 → 0.53 → **0.01** → 0.00 → 0.00 | **local 14–18** per city · ~100% |
| **HOUSE** | 0.68 → 0.66 → 0.51 → 0.32 → **0.31** | locks on only **2–51%** of days (median 15–20 where it locks) |
| **FLOOR** | 0.91 → 0.86 → 0.83 → **0.83** → 0.83 | almost never (0–36%; best jeddah 36% — narrow tropical ladders) |

Full pooled curves (median Brier by station-local hour):

| h | house (n≈1800) | market (n≈1776) | floor (n=1779) |
|---|---|---|---|
| 06 | 0.679 | 0.616 | 0.909 |
| 08 | 0.669 | 0.612 | 0.909 |
| 10 | 0.664 | 0.595 | 0.889 |
| 12 | 0.656 | 0.534 | 0.857 |
| 13 | 0.647 | 0.457 | 0.857 |
| 14 | 0.606 | 0.333 | 0.833 |
| 15 | 0.573 | 0.140 | 0.833 |
| 16 | 0.514 | 0.011 | 0.833 |
| 17 | 0.454 | 0.001 | 0.833 |
| 18 | 0.404 | 0.000 | 0.833 |
| 20 | 0.318 | 0.000 | 0.833 |
| 23 | 0.312 | 0.000 | 0.833 |

**Reading it:**

1. **The market locks between local 14:00 and 18:00 — during/just after peak-heat hours — on
   essentially every day, in every city.** By 16:00 local its median Brier is ~0.01.
2. **Our house distribution never catches that.** The nowcast constraint (dead buckets zeroed)
   moves us from 0.68 to ~0.31 by day end, but proper forecast mass stays hedged on
   still-alive higher buckets — the model cannot know the peak has passed, the market (order flow,
   humans watching obs) effectively does. The market is ahead of us at EVERY hour, including the
   morning (0.62 vs 0.68 at 06:00). This is the closed thesis's "intraday is already priced by a
   faster market", quantified per hour.
3. **The floor alone is NOT the market's information.** Uniform-over-alive stalls at 0.83: kills
   trim the ladder from below but can never concentrate on the winner (upper buckets stay alive
   until day end). The market's afternoon collapse is genuine peak-recognition, far beyond
   floor-kill bookkeeping. (Matches Build 1's decided-hour physics: the day is *physically* decided
   at median 14–15 local — the market prices that recognition within ~1–3 hours.)
4. **shenzhen cross-validates Build 2**: the market locks fine there (0.005 @16) while OUR house
   curve is the only one in the panel that never falls (0.71 → 0.74) — our instruments are
   METAR-replica-based and shenzhen's WU page is not a ZGSZ METAR render
   (`docs/RESOLUTION-RISK.md`). The market has no such problem because it resolves with WU.
5. Best-behaved city for us: **wellington** (house 0.106 @23, market lock 14:00 — also the
   forecast-accuracy leader in the live allowlist). Worst house laggards: shenzhen (0.74),
   beijing (0.51), cape-town (0.48).

## Per-city — HOUSE curve (median Brier at local hours) + house lock-in

From the DB scratch-table SQL (recipe below). locked% = share of days whose house Brier stays ≤0.1.

| city | h08 | h12 | h16 | h20 | h23 | lock med (locked%) |
|---|---|---|---|---|---|---|
| amsterdam | 0.756 | 0.855 | 0.640 | 0.462 | 0.462 | 18.0 (20%) |
| ankara | 0.557 | 0.549 | 0.423 | 0.331 | 0.331 | 16.0 (12%) |
| atlanta | 0.774 | 0.764 | 0.611 | 0.205 | 0.205 | 17.0 (37%) |
| austin | 0.579 | 0.603 | 0.545 | 0.440 | 0.440 | 18.0 (29%) |
| beijing | 0.795 | 0.788 | 0.676 | 0.509 | 0.509 | 19.0 (7%) |
| buenos-aires | 0.719 | 0.729 | 0.546 | 0.362 | 0.362 | 20.0 (23%) |
| busan | 0.603 | 0.727 | 0.518 | 0.215 | 0.215 | 19.5 (34%) |
| cape-town | 0.675 | 0.677 | 0.513 | 0.480 | 0.480 | 16.0 (2%) |
| chengdu | 0.686 | 0.691 | 0.634 | 0.373 | 0.312 | 6.0 (7%) |
| chicago | 0.624 | 0.627 | 0.446 | 0.179 | 0.179 | 18.0 (41%) |
| chongqing | 0.727 | 0.691 | 0.561 | 0.303 | 0.292 | 19.0 (17%) |
| dallas | 0.700 | 0.700 | 0.611 | 0.318 | 0.318 | 18.0 (34%) |
| denver | 0.578 | 0.576 | 0.525 | 0.162 | 0.162 | 17.0 (37%) |
| guangzhou | 0.689 | 0.666 | 0.571 | 0.374 | 0.374 | 18.0 (20%) |
| helsinki | 0.656 | 0.658 | 0.481 | 0.277 | 0.277 | 17.0 (32%) |
| houston | 0.723 | 0.723 | 0.347 | 0.256 | 0.256 | 15.5 (44%) |
| jeddah | 0.730 | 0.690 | 0.526 | 0.380 | 0.380 | 12.5 (34%) |
| karachi | 0.530 | 0.473 | 0.193 | 0.192 | 0.192 | 15.0 (41%) |
| kuala-lumpur | 0.619 | 0.542 | 0.397 | 0.267 | 0.267 | 18.5 (24%) |
| london | 0.702 | 0.652 | 0.540 | 0.428 | 0.394 | 18.0 (21%) |
| los-angeles | 0.522 | 0.548 | 0.156 | 0.156 | 0.156 | 15.0 (41%) |
| lucknow | 0.857 | 0.882 | 0.139 | 0.192 | 0.192 | 16.0 (41%) |
| madrid | 0.260 | 0.253 | 0.208 | 0.186 | 0.186 | 18.0 (25%) |
| manila | 0.703 | 0.757 | 0.679 | 0.338 | 0.338 | 19.0 (22%) |
| mexico-city | 0.624 | 0.630 | 0.455 | 0.323 | 0.323 | 16.5 (10%) |
| miami | 0.504 | 0.460 | 0.396 | 0.094 | 0.094 | 16.0 (51%) |
| milan | 0.541 | 0.558 | 0.482 | 0.200 | 0.200 | 17.0 (40%) |
| munich | 0.651 | 0.651 | 0.410 | 0.146 | 0.146 | 17.0 (37%) |
| nyc | 0.705 | 0.688 | 0.567 | 0.336 | 0.336 | 19.0 (37%) |
| panama-city | 0.690 | 0.627 | 0.421 | 0.343 | 0.343 | 15.0 (24%) |
| paris | 0.559 | 0.559 | 0.444 | 0.333 | 0.333 | 17.0 (32%) |
| qingdao | 0.684 | 0.732 | 0.518 | 0.241 | 0.241 | 16.0 (22%) |
| san-francisco | 0.639 | 0.600 | 0.445 | 0.338 | 0.338 | 16.0 (12%) |
| sao-paulo | 0.700 | 0.676 | 0.448 | 0.274 | 0.274 | 16.0 (28%) |
| seattle | 0.827 | 0.828 | 0.695 | 0.410 | 0.410 | 18.0 (17%) |
| seoul | 0.762 | 0.685 | 0.615 | 0.408 | 0.348 | 16.0 (17%) |
| shanghai | 0.650 | 0.701 | 0.555 | 0.319 | 0.319 | 18.0 (17%) |
| shenzhen | 0.714 | 0.735 | 0.708 | 0.738 | 0.738 | 20.0 (2%) |
| singapore | 0.542 | 0.508 | 0.449 | 0.284 | 0.284 | 17.0 (25%) |
| taipei | 0.697 | 0.670 | 0.671 | 0.453 | 0.453 | 19.0 (15%) |
| tokyo | 0.732 | 0.688 | 0.571 | 0.409 | 0.363 | 20.0 (32%) |
| toronto | 0.701 | 0.668 | 0.609 | 0.303 | 0.303 | 19.0 (27%) |
| warsaw | 0.548 | 0.589 | 0.316 | 0.270 | 0.270 | 16.0 (22%) |
| wellington | 0.400 | 0.450 | 0.214 | 0.214 | 0.106 | 14.0 (49%) |
| wuhan | 0.705 | 0.689 | 0.658 | 0.250 | 0.242 | 19.0 (18%) |

## Per-city — MARKET + FLOOR (regenerate with `python scripts/research/intraday-convergence.py`)

The script prints the full per-city market/floor table (median Brier at 08/12/16/20/23, lock-in
medians and locked-%) and writes `scripts/research/out/intraday-convergence.json`. Key columns are
summarized above; the JSON holds every cell. Market lock-in medians by city: earliest **karachi /
los-angeles / panama-city / qingdao / shanghai / singapore / taipei / tokyo / wellington at 14:00
local**, latest **madrid / paris / seattle at 18:00 local**; every city ~97–100% locked.

## The market_consensus censoring gotcha (measured, do not repeat)

The first attempt scored the market from the DB's `market_consensus` rows — that curve came out
FLAT (~0.62 all day), which would have read as "the market never converges". It is an artifact,
twice over: (1) `upsert_distribution` is `on conflict … do nothing` on `(event, source,
inputs_hash)` — unchanged mids never refresh `made_at`, so absence of rows means
*re-confirmed-unchanged*, not ghost; and (2) poll-markets effectively stops writing an event's
consensus before its resolution day unfolds — the median forward-fill lag at local 23:00 is
**15.5 hours**. **`market_consensus` is unusable for resolution-day intraday reads; use the
trade-print archive with the ghost-quote law.** (For dedup-upsert tables, the ghost-quote law
inverts: staleness ≠ ghost. Both halves matter.)

## Dashboard fold — DEFERRED (with reason)

The handoff allows shipping the research read first. The `/data` "intraday convergence" section is
deferred because a live RPC **cannot honestly reproduce the market curve today**: the DB's only
market-distribution stream is the censored `market_consensus` (above), and the trade-print archive
is local research data. Folding this into `/data` first requires either resolution-day-through-close
consensus polling in poll-markets (a live-lane design change → operator-gated) or an
`opening_captures`-based fold limited to the capture window. Either is cheap if wanted; neither
should ship as a silent approximation of this read. (Micro-budget + write-time-fold laws would
apply to any fold.)

## Regen

- MARKET+FLOOR: `python scripts/research/intraday-convergence.py [--start … --end …]`
  (extend `out/market-history/` first: `pnpm tsx scripts/research/pull-market-history.ts --cities all --from <date> --fidelity 10`).
- HOUSE: the chunked scratch-table recipe (run per ~1-week chunk against `bucket_probabilities`,
  aggregate, then drop) is recorded in this build's session; the core of it: per resolved
  mismatch-free event × local hour 6..23, Brier of the latest `house_gaussian` probs (`made_at ≤ t`,
  `probs[winning_bucket_idx+1]` convention per 0066) — medians per (city, hour), reverse-running-max
  lock-in per event. An unlogged scratch table keeps each statement small on the Micro instance;
  drop it when done.
