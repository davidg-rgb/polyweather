# Polyweather — Data-Layer Evaluation & Plan

> Generated 2026-06-13 by a multi-agent evaluation (35 agents: 6 parallel investigators →
> per-finding adversarial validation → synthesis). 28 findings, all survived validation;
> several wrong sub-theories refuted and dropped. Live-DB facts verified against project
> `lenysiqxihsmxljvyybt`.
>
> **Scope:** judged as an *analytics / decision-support* tool — see real data, log it over
> time, compute the model's probability, compare to Polymarket's implied odds, surface
> recommendations and patterns. **No live-trading / goLiveGate / wallet / KYC / ledger work
> is proposed.** Every issue is judged on one test: *does it block seeing real data, computed
> probabilities, model-vs-Polymarket edge, and recommendations?*

---

## Bottom line

The system collects data richly because the *collection* layer is ungated, but the *model*
and *decision* layers are dead because of a small number of upstream blockers — fundamentally
a **mix of by-design gating mis-applied to analytics, one config state never set, and one
genuine runtime bug**, not a flaw in the edge/recommendation code itself.

The model's own probability (`house_gaussian`) has **never been written** — all 21,356
`bucket_probabilities` rows are `market_consensus` (Polymarket's own odds echoed back), so
there is no model side to compare against the market. That is why `edge_evaluations=0` and
`bets=0` cascade downward and the dashboard's flagship "edge view" renders only half a chart.

Three things must ALL be true for the model to compute, and none are:
1. ≥1 **station verified** — a manual operator flag, never set (0 of 45).
2. **live forecasts actually captured** — broken: the live-capture job writes 0 rows every
   run despite valid inputs, and 100% of 670k forecasts are stale `backfill` ending 2026-06-11.
3. the **dead-man halt cleared** — currently active ("freshest forecast 55h old ≥ 30h").

Dashboard auth/deploy are healthy and the operator is logged in — the "no real data" complaint
is the empty decision layer surfaced on recommendation-centric pages, plus the home page never
showing the rich collected data that *does* exist.

---

## Confirmed issues, prioritized

The findings collapse into **one root-cause chain** plus a few independent surfacing/quality
issues. Refuted sub-claims were dropped: "operator logged out" (they signed in today);
"deploy broken / Vercel SSO wall" (deploy READY, `/login` publicly reachable);
"`operator_manual_bet` is a recommendation escape hatch" (it routes through execute-bet and
fills); "`cities.last_seen` staleness loop" (wrong table — `list_active_stations()` returns 45).

### 1. The model's own probability (`house_gaussian`) is never produced — nothing to compare to Polymarket
- **Severity:** Blocker · **In scope:** YES
- **Root cause:** Two independent, simultaneously-active gates each zero out the house build.
  (a) `list_buildable_events()` inner-joins `city_stations` on `cs.verified = true`; **0 of 45**
  stations verified → returns 0 (drop predicate → 100 buildable). (b) Even bypassing that,
  `get_build_inputs` excludes `snapshot_slot='backfill'` and **100% of 670,496 forecasts are
  backfill** (max target 2026-06-11, before the 06-12..15 open-event window) →
  `nonbackfill_forecast_keys=0` → `buildDistributionForEvent` hits its `inp.forecasts.length > 0`
  guard and writes nothing.
- **Evidence:** `supabase/migrations/0016_distribution_rpcs.sql:12` (verified gate), `:40`
  (backfill exclusion); `supabase/functions/_shared/distributions.ts:137` (forecast guard),
  `:162/:188` (only house writer); `build-distributions/handler.ts:6`. Live: `bucket_probabilities`
  21,356 rows, all `market_consensus`, **0 house_gaussian**; `build-distributions` job_runs
  `{events:0,written:0}`; `would_be_buildable=100`.
- **Fix:** Requires BOTH verify ≥1 station AND live non-backfill forecasts (Phases 1+2). Verifying alone produces nothing.

### 2. Live forecast capture is broken — `snapshot-forecasts` writes 0 rows every run (runtime bug)
- **Severity:** Blocker · **In scope:** YES
- **Root cause:** `snapshot-forecasts` (cron `15 10,22 * * *`, active) iterates
  `list_active_stations()` and reports `stations:0` on **every** run — including 06-12 10:15,
  06-12 22:15, 06-13 10:15, all *after* the 45-station universe was seeded (06-12 02:10) — yet
  `list_active_stations()` returns **45 now** against the same data. Not a timing/seeding lag — a
  genuine runtime defect where the deployed function gets `[]` at execution time. Identical
  `db.rpc('list_active_stations')` in `snapshot-ensembles` fails the same way (`stations:0`,
  `ensemble_snapshots=0`). Leading (unproven) hypothesis: the job returns 202 fast and does the
  real RPC work in `EdgeRuntime.waitUntil`, where the PostgREST call resolves to `[]` (mapped to
  empty, not thrown), recording `status:ok` with `stations:0`.
- **Evidence:** `snapshot-forecasts/handler.ts:40`, `snapshot-ensembles/handler.ts:28,72`. Live:
  `list_active_stations()`=45; job_runs `stations:0` on all 4 forecast + 4 ensemble runs;
  `forecast_snapshots` latest capture still 2026-06-11 12:00.
- **Fix:** Debug the live-capture path (Phase 2). The only item needing real code investigation,
  and the single most consequential bug — it keeps forecasts stale (feeds #3) and starves the
  house build even after verification.

### 3. A dead-man halt is currently active, blocking the bettable/recommendation path
- **Severity:** High · **In scope:** YES (clears once forecasts fresh)
- **Root cause:** `config['halt:global']` set (2026-06-13T19:00, "freshest forecast 55h old ≥ 30h").
  `halted()` returns true for every event (`poll-markets/handler.ts:186-189`). A *symptom* of #2,
  not independent — auto-clears once live forecasts resume.
- **Evidence:** Live config row; `poll-markets/handler.ts:186-189,304`.
- **Fix:** Resolving #2 clears it automatically; just confirm it clears.

### 4. Stations never verified + cities never betting-enabled — manual gate that also blocks analytics
- **Severity:** Blocker · **In scope:** YES
- **Root cause:** `verified`/`betting_enabled` default false, set only by `operator_verify_station`
  (flips **both** atomically), never run. Designed as live-trading authorization but ALSO gates the
  pure-analytics house build (`list_buildable_events`) and the edge audit
  (`poll-markets` bettable predicate). For an analytics tool the gate is mis-placed — it blocks
  *computing/seeing* a probability, not just placing a trade.
- **Evidence:** `0016_distribution_rpcs.sql:12`; `0021_operator_rpcs.sql:126-127`;
  `poll-markets/handler.ts:303`. Live: `cs_verified=0/45`, `cities_betting=0/49`.
- **Fix:** Phase 0 (operational flip) + Phase 3 (decouple analytics gates from the trading gate).

### 5. `edge_evaluations` is correctly paper-safe but doubly-gated, and only writes first 5 min/hour
- **Severity:** High (once upstream fixed) · **In scope:** YES
- **Root cause:** The `edge_evaluations` audit (F-038 "model-q vs Polymarket-ask per bucket, with
  reasons" — exactly the operator's desired surface) is NOT gated by trading mode/goLiveGate
  (correct). But it needs `edgeRowsByEvent.size > 0` (empty today, upstream) AND
  `now.getUTCMinutes() < 5` → even once unblocked it persists ~1 of 12 ticks/hour.
- **Evidence:** `poll-markets/handler.ts:512,522`; `0018_market_rpcs.sql:220-225`. Live: `edge_evaluations=0`.
- **Fix:** Phase 3 — populates hourly once upstream fixed; optionally widen cadence for a denser series.

### 6. Home page renders only the empty decision layer; the rich collected data is unreachable
- **Severity:** High · **In scope:** YES
- **Root cause:** Landing page is a trader's cockpit (open recs, P&L, exposure, bankroll) — all
  reading empty `bets`/`bankroll`. Nav has only 5 links (today/calibration/bets/system/admin); there
  is **no events-list or city-list page**, and `/events/[slug]` is reachable only from empty decision
  surfaces. The operator lands on a dead-looking page with no path to the 119 open events that DO have
  rich `market_consensus` distributions and 195-point price sparks.
- **Evidence:** `apps/web/src/app/(dash)/page.tsx:24-67`; `(dash)/layout.tsx:13-19`;
  `dash_today_overview` reads only `bets`/`bankroll`. Live: 119 open events, 116k snapshots, 21k consensus dists.
- **Fix:** Phase 1 — add an events-list landing surface with collection-health counts. Cheap (surfaces
  existing data); the single fastest way to answer "I can't validate the DBs populate."

### 7. `/calibration` hardcodes house sources (hides 45 scored consensus rows); event "edge view" half-blank
- **Severity:** Medium · **In scope:** YES
- **Root cause:** `calibration/page.tsx:17` hardcodes `SOURCES=['house_gaussian','house_ensemble']`,
  so reliability diagrams render blank even though `market_consensus` has 45 fully-scored rows.
  Separately, per-event `DistributionOverlay`/`EdgeChart` get `houseProbs=null` → headline "edge view"
  shows only market bars.
- **Evidence:** `calibration/page.tsx:17,31-33`; `events/[slug]/page.tsx:49,63`;
  `apps/web/src/lib/edge-display.ts:97`. Live: `calibration_scores` market_consensus=45 (with
  reliability), house_gaussian=2 placeholders (null brier).
- **Fix:** Phase 1 (data-driven source list surfaces consensus reliability now) + auto-fills house side once #1/#2 land.

### Self-healing / informational (no action)
- **`nowcast_lift=0`** — empty only because the Sunday-gated `rebuild_nowcast_lift` has never fired
  (run-calibration ran Fri/Sat only). Next Sunday (2026-06-14 11:30 UTC) writes ~216 rows; source data
  (9.2k `intraday_advances`) exists. Out of scope; not a bug.
- **market-scoring cutoff coverage** — `score_distributions` is bet-free and correct; 12 resolved
  events went unscored only because market collection began *after* the lead cutoff. Self-heals as
  collection predates target dates. Optional one-off backfill of 61 resolved events (41 have market
  rows) would densify Brier history (Phase 3, optional).

---

## Out-of-scope (live-trading) — explicitly DO NOT DO

- Anything to make `goLiveGate` **pass** (the "0 out-of-sample days / bootstrap p=1 / Brier n/a"
  readout). It is a faithful downstream symptom of the empty model layer; the *underlying*
  model-vs-market Brier is what the operator wants — surfaced in the analytics view, NOT the gate.
- `execute-bet`, `POLY_PRIVATE_KEY` / wallet, KYC attestation, ledger reconciliation, geoblock, paper→live switch.
- `operator_manual_bet` as a "recommendation logger" — it routes through `execute-bet` and fills; do not wire it as the analytics path.
- Do **not** flip `tradingMode` to `live` (it is `paper`, correct, irrelevant to producing recommendations).

---

## Proposed plan — phased, fastest path to seeing real recommendations

### Phase 0 — Operational unblock (today, no code) — **S**
Confirms the chain can light up; necessary but not sufficient.
- **0a.** Run `operator_verify_station` for target cities (admin "verify {icao}" button, or for the
  analytics use-case `update city_stations set verified=true where valid_to is null`). Makes ~100
  events buildable and flips `betting_enabled`.
- **0b.** Confirm the dead-man `halt:global` clears once forecasts are fresh (won't yet — gated on Phase 2).
- **Note:** Alone this will NOT produce `house_gaussian` — there are no non-backfill forecasts
  (`nonbackfill_forecast_keys=0`). Necessary but not sufficient; Phase 2 is the real unblock.

### Phase 1 — Surface the data that already exists (cheap; parallel with Phase 2) — **S/M**
The operator can finally *see* real collected data and validate the DBs populate — directly answers
"the dashboard shows no real data."
- **1a.** **Events-list landing surface** (new page + nav link, `(dash)/layout.tsx:13-19`): the 119 open
  events, each linking to `/events/[slug]`, with collection-health columns (forecast rows, snapshot
  rows, last poll, latest consensus). Files: new `(dash)/events/page.tsx`, `loaders.ts`, `layout.tsx`.
- **1b.** Make `/calibration` source list **data-driven** (drop hardcoded `SOURCES` at `calibration/page.tsx:17`);
  render the 45 scored `market_consensus` reliability diagrams now.
- **1c.** On `/events/[slug]`, render the `market_consensus` distribution + price spark prominently even
  while `houseProbs=null` — make the "model side pending" state explicit, not blank.

### Phase 2 — Fix live forecast capture (the real pipeline bug) — **M/L**
Fresh non-backfill forecasts → clears the dead-man → `build-distributions` writes `house_gaussian` → the model probability exists.
- **2a.** Debug why `snapshot-forecasts` gets `stations:0` from `list_active_stations()` at runtime when
  the same RPC returns 45 on demand. Suspects: the `EdgeRuntime.waitUntil` deferred path resolving the
  RPC to `[]` post-response; a service-DB `db.rpc` wrapper mishandling the no-arg call; an error
  swallowed by `runJob`'s try/catch. Files: `snapshot-forecasts/handler.ts:40`, `_shared/db.ts` rpc
  wrapper, `_shared/runJob`. Same fix applies to `snapshot-ensembles/handler.ts:28`. Highest-value code task.
- **2b.** Once capture writes non-backfill 10Z/22Z rows for current targets, `get_build_inputs` returns
  forecasts and `build-distributions` (already scheduled+active) writes `house_gaussian` next run. Verify
  `bucket_probabilities` gains `house_gaussian` and the dead-man clears.

### Phase 3 — Decouple analytics from the trading gate + densify the edge audit — **M**
The model-vs-Polymarket edge computes for *every* open event regardless of betting authorization, and
accumulates as a time-series — the operator's core deliverable.
- **3a.** Relax analytics gates: drop `cs.verified = true` from `list_buildable_events` (or add an
  analytics path building `house_gaussian` for every open+ladder_ok event), and let the `edge_evaluations`
  audit record consensus-vs-model edge for any open event regardless of `betting_enabled`. Keep
  `verified`/`betting_enabled` gating only the (out-of-scope) bet/fill path. Files:
  `0016_distribution_rpcs.sql:12`; `poll-markets/handler.ts:302-306,384,512`.
- **3b.** Widen `edge_evaluations` write cadence from `getUTCMinutes()<5` once-hourly to every poll tick
  (idempotent on `captured_hour`) → dense model-vs-market edge series. File: `poll-markets/handler.ts:512`.
  Retention pruner already bounds the table.
- **3c.** Once `house_gaussian` exists, `/events` "edge view" and `/calibration` house diagrams fill
  automatically. Optional one-off `score_distributions` backfill over 61 resolved events densifies the
  model-vs-market Brier history.

### Critical path & uncertainty
- **Fastest visible win:** Phase 1 (hours) — surfaces rich data already collected, no pipeline work.
- **Fastest real recommendation:** Phase 0a + Phase 2a → 2b. The gating item is **2a (the live-capture
  runtime bug)** — without fresh forecasts nothing produces a model probability.
- **Honest caveat:** the deployed function could not be invoked read-only, so the exact `stations:0`
  mechanism is **unproven** (waitUntil/RPC-resolution is the leading hypothesis) — budget for an
  investigation, not a one-line fix. Also, only ~10 of 45 active ICAOs currently have `model_stats`, so
  first house builds will cover a subset of cities, not all 49 (the backfill addresses this over time).

### Security note
The config dump during investigation surfaced a live `wuApiKey` value into the transcript (archived to
`_Logs/`). Treat it as compromised and **rotate it**.
