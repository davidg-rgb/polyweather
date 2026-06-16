# AMSTERDAM BUILD-OUT — the "one accurate city" deliverable

> **✅ DELIVERED (2026-06-16): the $10/day paper-trade head-to-head.** The accuracy finding below was
> turned into a live, self-scoring product — `$10/day` on our predicted bucket at **13/14/15/16 local**,
> racing to see which hour gains the most after ~14 days, scored against the real Polymarket market.
> Engine `packages/core/src/sim/amsterdam.ts` (+ planners), migration `0039` (table + RPCs + cron),
> Edge Function `amsterdam-paper-trade`, backfill `scripts/amsterdam-sim.ts`, dashboard `/amsterdam`.
> Full design + the best-time finding: **`AMSTERDAM-SIM.md`**. Suite 710 green. Go-live is
> operator-gated (apply `0039` + deploy the function + run the seed — see AMSTERDAM-SIM.md §3 / RUNBOOK).

> **Handoff doc.** The operator reframed the analytics-pivot goal (BUILD-STATE "PIVOT TO
> ANALYTICS VALUE", 2026-06-15) to a concrete, falsifiable target: **get a solid, close-to-true
> daily-Tmax prediction rate on ONE city.** This session picked the city (Amsterdam/EHAM),
> proved the method works on real data, and produced a live prediction. This doc is the build
> plan to turn that finding into a shipped, self-scoring product.
>
> Companion docs: `BUILD-STATE.md` (overall status), `FORECASTING-RD.md` (why trading is closed),
> `CLAUDE.md` (project context). Memory: `01 Memory/Polyweather/2026-06-16_2253__*`.

---

## 0. TL;DR for the next session

1. **City = Amsterdam (EHAM / Schiphol).** Lowest bias-free day-ahead scatter in the fleet
   (0.72°C), cleanly modeled, and **Polymarket runs a daily Amsterdam market that resolves to
   the Wunderground EHAM daily high in whole °C** — i.e. *exactly* our
   `observations.tmax_wu_native` (provenance `wu`, unit `C`). Our truth = the market's truth.
2. **Method = predict from the intraday running-max METAR, not the day-ahead NWP.** PROVEN on
   182 days: by **15:00 local the running max alone calls the exact whole-°C bucket 86% of the
   time (MAE 0.19°C); by 16:00, 92% (MAE 0.12°C).** Day-ahead NWP is MAE 0.75 / ~51% exact.
3. **The trading thesis stays closed.** This is an *accuracy / insight* product, not a taker.
   The nowcast is "already priced by a faster market" (WO-5) — irrelevant here, because the
   goal is to BE right, not to beat the market. Do **not** reopen `packages/trading`.
4. **MVP to build (Phase A below):** a single-city prediction engine + a daily issuance that
   stores its call and self-scores against the actual. Small. No cathedral.

---

## 1. The proven finding (don't re-run — captured here)

### 1a. Why Amsterdam — fleet day-ahead skill (lead +1, n≈89 since ~2026-03, °C)
Ordered by **bias-free scatter** (the true accuracy floor after a trivial per-station offset):

| City | ICAO | bias | raw MAE | scatter | exact-bucket (de-biased) | within-1°C |
|---|---|---|---|---|---|---|
| **Amsterdam** | EHAM | +0.49 | 0.75 | **0.72** | 51% | **82%** |
| Miami | KMIA | +0.81 | 0.89 | 0.78 | 48% | 80% |
| Paris | LFPB | +0.56 | 0.82 | 0.82 | 52% | 74% |
| Wellington | NZWN | +0.72 | 0.91 | 0.83 | 56% | 71% |
| Madrid | LEMD | +0.75 | 1.04 | 1.05 | 55% | 82% |

Amsterdam wins on the metric that matters (lowest *unpredictable* error) and has a liquid
Polymarket market for live benchmarking. Miami is the fallback if an Amsterdam market is ever
unavailable.

### 1b. The nowcast accuracy — EHAM, 182 days, running-max-by-local-hour vs final WU high
This is the engine. Raw running max, **zero lift** (the `mean_lift_needed` by mid-afternoon is
only 0.12–0.19°C, so a lift correction barely moves it):

| Local hour (CEST) | MAE °C | exact-bucket hit | within ±1°C |
|---|---|---|---|
| 11:00 | 1.64 | 27% | 49% |
| 12:00 | 1.09 | 38% | 66% |
| 13:00 | 0.65 | 53% | 86% |
| 14:00 | 0.40 | 68% | 94% |
| **15:00** | **0.19** | **86%** | 96% |
| **16:00** | **0.12** | **92%** | 97% |
| 17:00 | 0.11 | 93% | 97% |
| 19:00 | 0.07 | 95% | 98% |

**Operating procedure:** publish the day-ahead prior, then LOCK the call from the running max
at ~16:00 local → 92% exact-bucket. The reproducing query is in §5 (re-run to refresh / extend
to more leads).

### 1c. The live prediction already on the board (verify it!)
- **Market:** Polymarket "highest temp at Amsterdam Schiphol on 17 Jun '26", whole °C, WU source.
- **Day-ahead call (made 16 Jun, 10Z):** cross-model mean 21.9°C raw → **22.3°C** after +0.49
  bias → **primary bucket 22°C, secondary 23°C.** Matches BBC/AccuWeather (22–23) + trader
  consensus — independent corroboration.
- **High-confidence call lands 17 Jun ~16:00 CEST (~14:00 UTC):** read the running max → 92%.
- **SCORE IT on 18 Jun** against `observations.tmax_wu_native` for EHAM 2026-06-17. First real
  data point on the live track record.

---

## 2. Build scope

### Phase A — MVP: prediction engine + daily issuance + self-scoring  ← build this first
**Goal:** one command (and one cron) that, for any date, emits Amsterdam's predicted bucket +
confidence, stores it, and scores it once the actual finalizes.

- **A1. `scripts/predict-amsterdam.ts`** (new) — pure-ish engine, mirrors the `scripts/*` +
  `scripts/lib/` idiom (`makeScriptDb()`, `loadEnv()`). Signature: `predictAmsterdam(date, asOf)`.
  - If `asOf` is before the target day's local morning → **prior mode**: cross-model mean of
    lead-1 `forecast_snapshots` for the date + `+0.49` bias offset → `round()` → bucket;
    confidence from the day-ahead distribution (~51% exact / 82% within-1).
  - If `asOf` is during the target day → **nowcast mode**: `runningMax = max(max_tenths_c)` over
    `intraday_advances` for (EHAM, date, local_hour ≤ asOf_local_hour); predicted bucket =
    `round(runningMax)` (optionally `+ nowcast_lift.p50_remaining[hour]` — measure both, keep the
    better; raw is already 86–92% at h15–16); confidence = the §1b curve at that hour.
  - Output a small struct: `{date, asOf, mode, predictedBucketC, runningMaxC, dayAheadMeanC,
    confidenceExact, confidenceWithin1, source}`. Unit-test the bucket math + mode switch.
- **A2. Storage** — a `city_predictions` table (migration, follows the post-0034 grant idiom:
  own revoke/grant, add to `migrations.test.ts` WEB_AUTHENTICATED if it gets a dash RPC).
  Columns ≈ `(icao, target_date, issued_at, local_hour, mode, predicted_bucket_c,
  running_max_c, day_ahead_mean_c, confidence_exact, actual_c, hit, within_1, scored_at)`.
  Idempotent upsert per (icao, target_date, local_hour) so re-runs through the day overwrite.
- **A3. Daily issuance + scoring** — either a Supabase Edge function on pg_cron (preferred,
  matches the system) or, if the operator wants it off-prod, a scheduled `scripts/` run.
  - Issue: at the local "lock" hour (~16:00 CEST / 14:00 UTC) write the nowcast call.
  - Score: once the EHAM observation for the date `finalized_at`, fill `actual_c`/`hit`/
    `within_1`. Reuse the existing finalize path / `observations` as truth.
- **A4. Backtest the issuance** over the last ~182 days at the lock hour → confirm the realized
  hit rate matches §1b (~92% exact). This is the "score its real hit rate" proof.

**DoD for Phase A:** `predict-amsterdam.ts` reproduces the §1c call; backtest shows ≥85% exact
at the 16:00 lock; the live 17-Jun call is stored and scored on the 18th; suite green, typecheck 0.

### Phase B — surface it (the "headline analytics deliverable" BUILD-STATE flagged TBD)
- **B1. `/city` intraday-nowcast panel** — extends the panel shipped this session (migration
  0038 / `dash_station_predictions`). Show the running-max curve climbing through the day, the
  predicted final + confidence band by hour, and (for resolved days) the actual + whether we hit.
  New RPC `dash_station_nowcast(slug, date)` over `intraday_advances` + `nowcast_lift`, same
  revoke/grant idiom.
- **B2. Live track-record view** — Amsterdam's stored predictions vs actuals over time:
  realized exact-bucket %, within-1 %, MAE, and **vs the Polymarket consensus** (we already have
  `bucket_probabilities` source `market_consensus` + `market_events.poly_resolved_winner_idx`).
  "Our 16:00 call vs the market vs the truth" is the compelling story.
- **B3. (optional) public/headline framing** — if this becomes the product's front page, demote
  `bets`, promote the forecast-skill + Amsterdam-prediction story. Operator decision (§4).

### Phase C — generalize (only after A+B land for Amsterdam)
- Roll the engine to the top-5 cleanest cities (Miami, Paris, Wellington, Madrid).
- **Coastal-bias scan** (separate finding): the worst stations (Seoul, Jeddah, Singapore, KL,
  Taipei) all under-forecast with large positive bias — likely a coastal/island grid-
  representativeness pattern. Correlate per-station bias vs coastline proximity / land-sea mask;
  a per-station offset layer would lift fleet MAE. (Seoul/RKSI is the extreme: +3.6°C, diagnosed
  this session as a forecast bias, NOT a data bug — see memory + §6.)

---

## 3. The algorithm (precise)

```
predictAmsterdam(targetDate, asOf):
  localHour = hour of asOf in Europe/Amsterdam
  if asOf.date < targetDate (or before ~the day's first METAR):
     mean = avg(tmax_c) over lead-1 forecast_snapshots[EHAM, targetDate]   # ~9 models, see §6
     pred = round(mean + 0.49)                                             # bias offset
     conf = {exact: ~0.51, within1: ~0.82}                                 # day-ahead
  else:
     runMax = max(max_tenths_c) over intraday_advances[EHAM, targetDate, local_hour ≤ localHour]
     pred   = round(runMax)            # optionally round(runMax + nowcast_lift.p50[localHour])
     conf   = curve(localHour)         # §1b table; e.g. h16 → {exact:0.92, within1:0.97}
  return {pred, runMax, mean, conf, mode}
```

Resolution bucket = whole °C (`round`). The market resolves to the same `round(WU high)`.

---

## 4. Operator decisions (resolve before/while building)

1. **Where does issuance run?** pg_cron Edge function (on-prod, matches the system, but prod
   touches) **vs** a local scheduled `scripts/` run (off-prod, operator-gated deploys avoided).
   *Recommendation: Edge function — it's the system's idiom and the data already lives there.*
2. **Lift or raw?** Raw running max is 86–92% at h15–16. Adding `nowcast_lift.p50` mainly helps
   earlier hours (h11–13). *Recommendation: ship raw for the lock-hour MVP; measure lift as a
   stretch — don't gate Phase A on it.*
3. **Is this the headline product** (front-page, demote `bets`), or an internal accuracy panel?
   Drives Phase B3 scope.
4. **Lock hour** — 16:00 CEST gives 92% at ~4h before EOD. Earlier (15:00, 86%) is more lead;
   later (17:00, 93%) is marginally better. Pick the operating point.

## 5. Reproducing queries (hosted; set the operator JWT claim first)

`set_config('request.jwt.claims', '{"email":"david.geborek@gmail.com"}', false)` is NOT needed
for raw table SELECTs via MCP `execute_sql` (privileged role) — only for `operator_guard()`-
gated dash RPCs. The nowcast-accuracy query:

```sql
with final as (select date_local, tmax_wu_native::numeric as final_c
               from observations where icao='EHAM' and finalized_at is not null),
hours as (select generate_series(9,21) as h),
rm as (select f.date_local, hh.h, f.final_c,
         (select max(ia.max_tenths_c) from intraday_advances ia
          where ia.icao='EHAM' and ia.date_local=f.date_local and ia.local_hour<=hh.h) as runmax
       from final f cross join hours hh)
select h as local_hour, count(runmax) n_days,
  round(avg(final_c-runmax)::numeric,2) mean_lift_needed,
  round(avg(abs(final_c-runmax))::numeric,2) mae,
  round(avg((round(runmax)=final_c)::int)::numeric,2) exact_hit,
  round(avg((abs(final_c-runmax)<=1.0)::int)::numeric,2) within_1
from rm where runmax is not null group by h order by h;
```

The fleet skill-ranking + the day-ahead bias query are in the 2026-06-16 session memory.

## 6. Data facts & gotchas (will bite you otherwise)

- **`intraday_advances(icao, date_local, local_hour, max_tenths_c)`** = running max by local
  hour. `max_tenths_c` is a **MISNOMER — already °C, do NOT divide by 10** (verified). PK
  (icao, date_local, local_hour). `local_hour` is **station-local** (Europe/Amsterdam for EHAM,
  CEST in summer) and is the trustworthy intraday clock — NOT `created_at` (that's backfill time,
  per WO-5). Populated by the `metar-nowcast` job; EHAM has 182 days, current to ~2026-06-15.
- **`nowcast_lift(icao, local_hour, p50_remaining, p90_remaining, n)`** = learned expected
  additional °C rise after hour H (the lift). Recomputed globally — refit walk-forward if used
  for scoring (see `scripts/research/wo4-nowcast-value.ts`).
- **`intraday_max`** = ONE final row per (icao, date_local). Not hourly — don't use it for the
  nowcast curve.
- **Truth = `observations.tmax_wu_native`** for EHAM, unit `C`, provenance `wu`. This IS the
  Polymarket resolution source (WU Schiphol daily high, whole °C). `finalized_at` gates "scored".
- **`forecast_snapshots`** carries ~9 models for EHAM: `best_match, cma_grapes_global,
  ecmwf_ifs025, gem_seamless, gfs_seamless, icon_seamless, jma_seamless, meteofrance_seamless,
  ukmo_seamless`. The day-ahead "mean" in §1/§3 (and migrations 0037/0038) averages ALL of them
  at `lead_days=1`. Two daily slots `10Z`/`22Z`; the freshest lead-1 for a target is the 10Z on
  the prior day. `tmax_c` is already °C.
- **Bias offset = +0.49°C** for EHAM lead-1, measured over 89 recent days. Recompute as data
  grows; it's a per-station constant, not a per-model MOS (the per-model MOS that R&D rejected is
  a different thing — see FORECASTING-RD.md, don't conflate).
- **Market resolution data already stored:** `market_events.poly_resolved_winner_idx` (Polymarket
  outcome), `winning_bucket_idx` (our computed winner), `grading_mismatch`; `bucket_probabilities`
  source `market_consensus` for the market's pre-resolution view. Use for B2.
- **Hosted migration applies are operator-gated** (the auto-classifier blocks unprompted DDL;
  the operator authorizes per-action). Web pushes auto-deploy via Vercel. Loaders for any new RPC
  should degrade-to-null on error so the page can deploy ahead of the RPC (see the 0038 loader).

## 7. Risks / edge cases

- **Late-day spike:** the daily high occasionally prints after the lock hour (the 8–14% miss at
  h15–16). Running max can only undershoot → misses are low and almost always by exactly 1 bucket
  (within-1 = 96–97%). A small upward lift hedges; quantify before trusting a single call.
- **METAR feed health:** the nowcast is only as fresh as `intraday_advances`. If `metar-nowcast`
  stalls, the running max is stale and the call degrades silently — add a freshness guard
  (last_obs age) to the issuance.
- **Timezone/DST:** `local_hour` is local, so handled, but the climatological peak shifts with
  CET↔CEST; the §1b curve was learned across a DST boundary (minor; re-segment if precision matters).
- **WU revisions:** Polymarket honors revisions until the next day's first datapoint; our
  `finalize_observation` window should align before we mark a prediction "scored/correct".

## 8. Non-goals (per the prime directive + the closed thesis)

- **No trading.** Don't touch `packages/trading` or the `bets` surface. This is accuracy/insight.
- **No fleet-wide build first.** Nail Amsterdam end-to-end (A+B) before Phase C generalization —
  resist the avoidance pattern of building the general framework to dodge shipping the one city.
- **No NWP model R&D.** The blend is at its ceiling (4 rejected levers, FORECASTING-RD.md). The
  win here is the *nowcast*, not a better day-ahead model.
