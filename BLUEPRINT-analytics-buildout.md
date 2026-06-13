# Polyweather — Analytics & Recommendation Buildout — Architecture Delta Blueprint

> Generated from DATA-LAYER-REVIEW.md (validated findings) + ARCHITECTURE.md (original blueprint) + live source. Date 2026-06-13.
>
> **IMPLEMENTATION STATUS (2026-06-13): Phase 1 + Phase 2a SHIPPED** (local, typecheck 0 / 597 tests green across 48 files; operator-deploy-gated for hosted). Operator sign-offs recorded: **ADR-18 = decouple (yes)**, **ADR-20 = reliable-hourly**, **ADR-21 = /events default landing (yes)**.
> - **Phase 2a (capture instrument):** C1 `JobInputError` + empty-station guards (snapshot-forecasts/ensembles), C2 `db.ts` null-vs-`[]` diagnostic. DONE.
> - **Phase 1 (surface + audit write-path):** WEB-1..6 (`dash_events_list` migration 0029, `getEventsList`, `/events` landing + nav + default, data-driven `/calibration`, model-pending `/events/[slug]` + `/city/[slug]` + `DistributionOverlay`); EDGE-1/2/3 (analytics edge pass + drop clock gate, lands DORMANT until a house champion exists). DONE.
> - **NOT YET (Phase 2b / Phase 3 — future sessions):** capture-defect root-fix from the C1/C2 evidence (one hosted fire), `operator_resume('halt:global')`, HD-1 (`list_buildable_events` drop `cs.verified=true`, migration **0028**) + §6.16 prose amend, DF-5 scored history. Until those land, EDGE-1/2/3 records 0 rows (no house champion exists yet) — by design.
> - **Deploy steps (operator-gated):** apply migration 0029 to hosted (additive read-only RPC); redeploy `poll-markets`, `snapshot-forecasts`, `snapshot-ensembles` edge functions; `vercel` redeploy for the web changes. See RUNBOOK.
>
> Status: BUILD-READY reference — Phase 1 + 2a built against it.
>
> Lead-architect assembly of 6 subsystem delta-specs (capture, house-build, edge-audit, dashboard, end-to-end data-flow + scoring, original-architecture alignment). Every claim re-verified against real source and the live DB (`lenysiqxihsmxljvyybt`). One spec claim was found **wrong on re-verification and is corrected here** — see §7 / §11 (the `bucket_probabilities_event_source_time_idx` index DOES exist).
>
> **Naming collision resolved:** three specs each proposed a migration named `0028`. This blueprint allocates **one** new migration for the SQL gate/RPC changes (`0028_analytics_decouple.sql`) and a **second** for the new dashboard RPC (`0029_dashboard_events_list.sql`). The live repo already contains an applied `0027` (per `git log`: "0027 applied"), so the next free numbers are 0028/0029.

---

## 1. Executive Summary — what changes and why

The operator wants an **analytics / decision-support** tool, not a trading bot. The desired pipeline is:

```
collect real data  →  compute the MODEL's own probability (house_gaussian)
                   →  compare model q vs Polymarket implied odds (the edge)
                   →  log that edge as a time-series (edge_evaluations)
                   →  surface recommendations + patterns on the dashboard
                   →  score model-vs-market over time (Brier history that grows)
```

Today the **collection** layer is rich and ungated (119 open events, 21,581 `market_consensus` distributions, 670,496 forecast rows, 195-point price sparks — all **live-verified**), but the **model** and **decision** layers are dead, because of one root-cause chain:

**The model's own probability `house_gaussian` has NEVER been written.** Live: `bucket_probabilities` = 21,581 rows, **0 house_gaussian, 0 house_ensemble, 21,581 market_consensus** (Polymarket's own odds echoed back). With no model side there is nothing to compare to the market, so `edge_evaluations = 0` and `bets = 0` cascade downward and the dashboard's flagship edge view renders half a chart.

The house build is zeroed by **two independent, simultaneously-active gates** (both verified in source + live):

- **Gate A — the verified inner-join.** `list_buildable_events()` inner-joins `city_stations` on `cs.verified = true` (`supabase/migrations/0016_distribution_rpcs.sql:12`). Live: **0 of 45** active stations verified → the RPC returns **0** rows → `build-distributions` iterates over nothing. De-gating the query yields **100 buildable events across 44 distinct ICAOs** (live-verified).
- **Gate B — the backfill exclusion.** `get_build_inputs` filters `fs.snapshot_slot <> 'backfill'` (`0016:40`, ensembles `:56`). Live: **100% of 670,496 forecast rows are `snapshot_slot='backfill'`** (max target 2026-06-11), `fc_nonbackfill = 0` → `get_build_inputs` returns `forecasts=[]` → `buildDistributionForEvent` hits its `if (inp.forecasts.length > 0)` guard (`distributions.ts:137`) and writes nothing.

Gate B is itself caused by **Issue #2** — a deployed-runtime capture defect: `snapshot-forecasts` / `snapshot-ensembles` report `stations:0` on **every** scheduled run even though `list_active_stations()` returns **45** on demand. No fresh non-backfill forecasts land, the dead-man halt (`config['halt:global']`) fires (live: active since 2026-06-13T19:00, "freshest forecast 55h old ≥ 30h"), and `poll-markets` halts every event.

Layered on top of the chain are **surfacing/quality gaps**: the verified flag (a trading-authorization gate) is mis-applied to the analytics build and edge-audit; the edge audit is also clock-gated to "first 5 min of the hour" (and the live cron `15 10,22` **never lands in that window**, so the audit never fires on the real schedule); the dashboard landing page reads only empty bet-side data; `/calibration` hardcodes house-only sources and hides 45 scored `market_consensus` reliability rows; `/events/[slug]` shows a half-blank overlay with no "model pending" explanation.

**What this blueprint changes (analytics-only, no live trading):**

1. **Decouple analytics from the trading gate** — `house_gaussian` builds and `edge_evaluations` records for **every open, ladder-ok event**, regardless of `verified`/`betting_enabled`. Those flags continue to gate ONLY the (out-of-scope) bet/fill path. (New **ADR-18**.)
2. **Fix live capture** — turn the silent `stations:0` `ok` run into a loud, retryable `failed`, and instrument the exact PostgREST null-vs-`[]` mechanism so the next real run pins it deterministically. (New **ADR-19** / risk entry.)
3. **Widen the edge audit cadence correctly** — fire on every poll tick, idempotent on `captured_hour`. **Adversarial correction (X-3b): with `captured_hour` hour-truncated, "every tick" yields exactly one row per (event,bucket,hour) — it makes the audit RELIABLE, it does NOT densify within the hour.** Sub-hour densification needs a granularity change to the unique key + retention; flagged as an operator decision.
4. **Surface the data** — new `/events` collection-health landing + nav link; data-driven `/calibration` sources; explicit "model pending" state on `/events/[slug]`.
5. **Grow a scored model-vs-market history honestly** — via the already-built, already-tested `simulate-historical-edge` walk-forward scorer (information-time-matched), NOT live retro-builds (which would peek).

The **one root-cause chain, plainly:** _verified-gate + backfill-only-forecasts → 0 house_gaussian → 0 edge_evaluations → 0 bets → a dashboard that surfaces only the empty decision layer._ Break the chain (de-gate + fix capture) and the whole analytics surface lights up on the next build cycle.

---

## 2. Scope & Findings Recap

| # | Finding | In scope | Phase | Owning subsystem |
|---|---|---|---|---|
| **#1** | `house_gaussian` never produced — Gate A (verified join) + Gate B (backfill exclusion) | **YES** | 2 + 3 | house-build / data-flow |
| **#2** | Live capture broken — `snapshot-forecasts` writes 0 rows every run (runtime defect) | **YES** | 2 (gating) | capture |
| **#3** | Dead-man `halt:global` active | **YES** | 2 | capture (corrected: does NOT auto-clear) |
| **#4** | Stations never verified / cities never betting-enabled — trading gate mis-applied to analytics | **YES** | 3 | house-build / edge-audit / alignment |
| **#5** | `edge_evaluations` doubly-gated + clock-gated (writes ~1 of 12 ticks/hr, never on the live cron) | **YES** | 1 / 3 | edge-audit |
| **#6** | Home page renders only the empty decision layer; no events-list; rich data unreachable | **YES** | 1 | dashboard |
| **#7** | `/calibration` hardcodes house sources (hides 45 scored consensus rows); event edge view half-blank | **YES** | 1 | dashboard |

### Explicit OUT-OF-SCOPE — DO NOT TOUCH (live-trading machinery)

- Anything to make `goLiveGate()` **pass** (the "0 out-of-sample days / bootstrap p=1 / Brier n/a" readout). It is a faithful downstream symptom; the underlying model-vs-market Brier is what the operator wants — surfaced in the analytics view, NOT the gate.
- `execute-bet`, `POLY_PRIVATE_KEY` / wallet, `@polymarket/clob-client`, KYC attestation, ledger reconciliation (F-033), geoblock, paper→live switch.
- `operator_manual_bet` as a "recommendation logger" — it routes through `execute-bet` and **fills**; never wire it as the analytics path.
- Do **not** flip `tradingMode` to `live` (it is `paper`, correct, irrelevant to producing recommendations).
- The `verified`/`betting_enabled` **bet-path** gate (`poll-markets/handler.ts:302-305` candidate gate; `:366`/`:368` → `edge.ts:99` `station_unverified` veto; sizing/recommendation/bet writes) stays **intact and gated**. This blueprint only frees the **build** and **audit** paths.

---

## 3. Architecture Decision Records (the delta decisions)

### ADR-18 — Analytics decoupled from the trading-authorization gate **[NEEDS OPERATOR SIGN-OFF]**

**Decision.** `cs.verified=true` and `cities.betting_enabled=true` gate the (out-of-scope) **bet/fill path EXCLUSIVELY**. The pure-analytics surfaces — `house_gaussian`/`house_ensemble` distribution builds (`list_buildable_events`) and the `edge_evaluations` model-vs-market audit (F-038) — compute for **every open, gradable, ladder-ok event** regardless of operator verification.

**Alternatives.** (a) Keep the original trading-first gate and ask the operator to manually `operator_verify_station` per city (Phase-0 interim, no code) — rejected as permanent design: requiring a manual flip before the model will even *compute* a probability is a trading gate mis-applied to analytics. (b) Add a second parallel "analytics build" RPC leaving `list_buildable_events` untouched — rejected as needless duplication; `list_buildable_events` has exactly one caller (`build-distributions/handler.ts:6`, whole-repo grep), so editing it in place is contained and clean.

**Why.** ADR-06's premise (§3, ARCHITECTURE.md:202) — "all sources write to `bucket_probabilities` tagged by source; scoring treats sources symmetrically" — is *impossible* if house rows are never written. F-038 the requirement (ARCHITECTURE.md:105) literally says "for every open event"; the §6.17 step-8 *implementation* narrowed it to "candidate events". The operator's restated goal (analytics, no trading) makes "compute for every open event" the correct reading.

**Alignment / deviation vs original §3.** This **reverses the trading-first framing** of **ADR-03** (ARCHITECTURE.md:188-191, "a station change auto-suspends *betting*…pending re-verification") and **ADR-10** (218-220, executor privilege boundary) **for the analytics surfaces only**. It does NOT touch the bet/fill chokepoint (execute-bet) or its gate. It RE-ALIGNS the code with **ADR-06** (symmetric scoring) and **F-038** (every open event). Because it changes what `verified` *means*, it is recorded as a **new ADR-18** rather than a silent divergence. **Constraint (binds ADR-16, ARCHITECTURE.md:242-247):** house rows produced under the relaxed gate must still be made at `made_at ≤ cutoff(event,lead)` so the both-sources time-matched Brier stays unbiased — `gradeEvent` stamps the last row with `made_at ≤ cutoff` for EACH source symmetrically, so widening the *event set* can only ADD matched pairs, never tilt the comparison. ADR-16's row-existence guarantee (ARCHITECTURE.md:244) actually *improves*: house rows now exist for all cities with a snapshot cycle, not just verified ones.

**Sign-off required:** confirm `verified` gates the bet/fill path ONLY, and `house_gaussian + edge_evaluations` compute for every open ladder-ok event.

### ADR-19 — The capture `stations:0` defect is a deployed-runtime RPC-resolution bug; classify by literal signature before fixing **[risk-register / §13 entry]**

**Decision.** Treat `snapshot-forecasts`/`snapshot-ensembles` `stations:0` as an **unproven runtime defect**. Do NOT ship a speculative one-line fix. Instead: (1) make the empty-station run a **loud retryable `failed`** (Change C1), and (2) **instrument** the raw PostgREST `data`/`error` *before* the `db.ts:40` normalization (Change C2) so one hosted run reveals whether PostgREST returns `null` (no rows over the wire) vs `[]` (empty SETOF) vs a swallowed throw.

**Alternatives.** Ship the review's leading hypothesis as fact (waitUntil-deferred RPC resolving to `[]`) — rejected: it is **unproven**, and a co-equal candidate exists that the same evidence fits at least as well (the `db.ts:40` `data === null → []` coercion firing for a `RETURNS TABLE` fn). Picking the wrong one wastes the gating Phase-2 task.

**Why.** The pinned live signature — `{stations:0, stationsFailed:0, modelsMissing:[], status:ok, dur≈1s}` on every 10Z/22Z run, while `complete_job_run` wrote full stats *inside* `waitUntil` (so the isolate was not killed) — proves `stations.length === 0` at handler time and that the closure ran to completion. `list_enabled_models` runs in the **same** `waitUntil` closure and returns 2, so `waitUntil` + the supabase-js RPC client both function; the empty set is **specific to `list_active_stations`**.

**Alignment vs §3.** Lives squarely inside **ADR-02** (202-then-`waitUntil`, ARCHITECTURE.md:184-186) and **ADR-12** (`job_runs` is the source of truth; "a killed isolate mid-`waitUntil` must not wedge a period forever", ARCHITECTURE.md:227-228). Change C1 RE-ALIGNS with ADR-12: today a zero-station run records `status:ok`, which `claim_job_run` then treats as `already_ran`, **permanently consuming the period** — worse than a stuck `running` (which the reaper at least reclaims). C1 converts that silent wedge into a retryable `failed`.

### ADR-20 — widen edge cadence + idempotency key (and the X-3b correction) **[partial sign-off]**

**Decision.** Drop the `getUTCMinutes() < 5` clock gate; persist `edge_evaluations` whenever `edgeRowsByEvent.size > 0`. Keep `captured_hour` hour-truncated; the `(event_id, bucket_idx, captured_hour)` unique key + `ON CONFLICT DO NOTHING` make every tick idempotent → exactly one row per (event,bucket,hour).

**Adversarial correction (X-3b — load-bearing).** DATA-LAYER-REVIEW §3b says "widen to every poll tick, idempotent on `captured_hour`" as if that *densifies* the series. **It does not.** With `captured_hour` truncated to the hour, all ticks in a UTC hour collide on the same key → the first tick inserts, ticks 2–N are silent no-ops. "Every tick" makes the audit **reliable** (it fires regardless of which minute the cron lands on — and the live cron `15 10,22` **never** satisfied `getUTCMinutes()<5`, so the audit previously *never fired on the real schedule*), but it yields the same per-hour cardinality. A genuinely sub-hour series requires changing `captured_hour` to the tick timestamp AND the unique key AND the retention pruner AND the dashboard read filter — a larger, separate change. **Operator decision:** reliable-hourly (one-line predicate change, no schema) vs sub-hour densification (multi-touch).

**Alternatives.** (a) Keep the clock gate but move it to "first tick of each UTC hour that has edge rows" — equivalent reliability, hour-granular, no schema change (the cheaper correct variant). (b) Switch `ON CONFLICT DO NOTHING` → `DO UPDATE` to keep the **latest** edge per hour rather than the first — flagged as an open question (operator may prefer the most-recent champion+price within the hour).

**Alignment vs §3.** Aligns with **ADR-12** (idempotency as default) and §7.21 retention. The series density is bounded by the poll cron (`*/5` in the original blueprint; live `15 10,22` twice-daily) — densifying the *audit* beyond the *poll* cadence is impossible without changing the poll cron (a separate ops decision).

### ADR-21 — dashboard surfacing (additive, in-idiom)

**Decision.** Add an `/events` collection-health landing page (new `dash_events_list` RPC + loader + page + nav link), make `/calibration` source list data-driven, and add an explicit "model pending" state to `/events/[slug]` + `DistributionOverlay`.

**Alignment / deviation vs original §15.** The original §15 page roster is **7 pages** (ARCHITECTURE.md:2263, 2425) with `/` (today) as the landing. Adding an **8th page** (`/events` index) + a nav link is an **additive deviation** justified because the original landing surfaces only bet-side data (empty in analytics mode). The new page exactly mirrors the existing `0022`/`loaders.ts` RPC-per-page idiom — same mechanism, not a new pattern. The `/calibration` data-driven fix and the `/events/[slug]` model-pending state are pure bug-fixes **aligned** with **ADR-06** (symmetric source treatment) and §6.21 — no sign-off needed. The §15 checklist line "Dashboard (§6.21): 7 pages render with real data" (ARCHITECTURE.md:2444, currently unchecked) becomes "8 pages".

**Sign-off (one-line yes/no):** should `/events` become the **default landing** (point the brand link + put it first in nav), leaving `/` (today) reachable but not primary?

---

## 4. As-Designed vs As-Built vs To-Be (per subsystem)

| Subsystem | As-DESIGNED (ARCHITECTURE.md) | As-BUILT (live, verified) | To-BE (this blueprint) |
|---|---|---|---|
| **Capture** (snapshot-forecasts/ensembles) | §6.14: iterate every station of an active city, upsert on natural key, gap-fill; a successful job wrote rows. §9.1 happy path. ADR-02/12: 202+`waitUntil`, `job_runs` is truth. | `list_active_stations()`=45 on demand, but every scheduled run records `{stations:0, status:ok}` → 0 rows written; 100% of 670k forecasts are stale `backfill`; dead-man `halt:global` active. | C1: empty-station run throws `JobInputError` → `status:failed` (retryable). C2: log raw PostgREST null-vs-`[]` to pin the mechanism. C3: dead-man halt cleared via `operator_resume` (does NOT auto-clear — corrected). |
| **House build** (build-distributions) | §6.16: "for every open market_event with a **verified station** … call buildDistributionForEvent." Backfill never feeds live builds (W19, ARCHITECTURE.md:1162). | `list_buildable_events()`=0 (verified inner-join, 0/45 verified) → builder iterates nothing; even de-gated, `get_build_inputs` returns `forecasts=[]` (backfill-only) → `length>0` guard skips. **0 house rows.** | HD-1/DF-1: drop `cs.verified=true` from `list_buildable_events` (→100 buildable). HD-3/DF-2: backfill exclusion stays correct (W19); the real Gate-B fix is upstream capture (C1/C2). Optional DF-2 `p_allow_backfill` param (default false) for seeding present/future open events. |
| **Edge audit** (poll-markets step 8) | §6.17 step 8 / F-038 (ARCHITECTURE.md:105, 1214-1215): persist ALL EdgeRows for **candidate** events to `edge_evaluations` on the first tick of each hour; §7.21 table + 30d retention. | Edge loop gated by `bettable` (verified+betting_enabled+…) → `edgeRowsByEvent` empty → audit `if (getUTCMinutes()<5 && size>0)` never fires (and never on the `15 10,22` cron). **0 edge_evaluations.** Champion null everywhere (0 house rows). | EDGE-1/DF-4(A): compute pure `computeBucketEdges` (no liquidity vetoes) for ALL open events with a champion, independent of `bettable`. EDGE-2/DF-4(B): drop the clock gate; persist every tick (idempotent). EDGE-3: invariant — `bettable` gates the bet path ONLY. X-3b: "every tick" = reliable, not denser. |
| **Dashboard** (apps/web) | §6.21 / F-030 (ARCHITECTURE.md:94): 7 pages incl. `/` (today), `/events/[slug]` (edge view), `/calibration`. ADR-13: dashboard reads everything, anon sees nothing. §15: "7 pages render with real data." | Landing reads only empty `bets`/`bankroll`; NAV = 5 links, no events/city list; `/calibration` hardcodes 2 house sources (hides 45 scored consensus rows); `/events/[slug]` overlay half-blank (`houseDist=null`) with no explanation. | WEB-1/2/3/4: new `dash_events_list` RPC + `getEventsList` loader + `/events` index page + nav link. WEB-5: data-driven `/calibration` sources. WEB-6: explicit "model pending" state on `/events/[slug]` + `DistributionOverlay`. |
| **Scoring** (run-calibration / grade-bets / simulate-historical-edge) | §6.18, §9.5, §9.7, ADR-16: per-(city,source,lead,window) Brier; pooled bootstrap; information-time-matched cutoffs; `simulate-historical-edge` walk-forward (window_tag='backtest'). | Scoring MACHINERY works: 45 scored `market_consensus` rows + 2 empty `house_gaussian` pooled rows (no house to pair); consensus history only reaches 2026-06-12, so pre-cutoff rows mostly absent. **0 backtest rows.** | DF-5: grow scored model-vs-market history via the existing `simulate-historical-edge` (information-honest), gated on a `backfill-market-history` prerequisite (synthesized consensus at pre-cutoff `made_at`). DF-6/WEB-5: surface the 45 already-scored consensus rows. No scoring-engine redesign. |

---

## 5. Project Structure Delta

```
supabase/
  migrations/
    0028_analytics_decouple.sql            NEW  — list_buildable_events drops cs.verified=true;
                                                  optional get_build_inputs p_allow_backfill param
    0029_dashboard_events_list.sql         NEW  — dash_events_list(p_champion) read-only RPC
    (0030_clear_system_halt.sql)           NEW (Phase-3 OPTIONAL) — system-only halt auto-recover RPC
  functions/
    _shared/
      db.ts                                MOD  — rpc wrapper: log raw null-vs-[] on empty SETOF (C2)
      runJob.ts                            —    (unchanged; JobInputError surfaces via existing path)
    snapshot-forecasts/handler.ts          MOD  — empty-station guard throws JobInputError (C1)
    snapshot-ensembles/handler.ts          MOD  — same guard before models fetch (C1)
    build-distributions/handler.ts         MOD  — docstring only; forward allowBackfill if adopted (HD-2/DF-3)
    poll-markets/handler.ts                MOD  — analytics edge pass over all-champion events (EDGE-1);
                                                  drop getUTCMinutes()<5 clock gate (EDGE-2)
    health-monitor/handler.ts              MOD (Phase-3 OPTIONAL) — system-halt auto-recover branch (C3)
  _shared/distributions.ts                 MOD (OPTIONAL) — buildDistributionForEvent opts.allowBackfill (DF-3)

packages/core/src/
  index.ts (or errors.ts)                  MOD  — export new JobInputError subclass (C1)

apps/web/src/
  app/(dash)/events/page.tsx               NEW  — /events collection-health landing (WEB-3)
  app/(dash)/layout.tsx                    MOD  — add ['/events','events'] to NAV (WEB-4)
  app/(dash)/calibration/page.tsx          MOD  — derive sources from rows; drop hardcoded SOURCES (WEB-5)
  app/(dash)/events/[slug]/page.tsx        MOD  — model-pending header + caption + overlay prop (WEB-6)
  app/(dash)/city/[slug]/page.tsx          MOD  — pass modelPending to DistributionOverlay (WEB-6 follow-on)
  components/DistributionOverlay.tsx       MOD  — optional modelPending prop + amber note (WEB-6)
  lib/loaders.ts                           MOD  — EventsListView/EventListRow types + getEventsList (WEB-2)

scripts/
  simulate-historical-edge.ts             —    (no code change; operational wiring only — DF-5)

supabase/tests/ , apps/web/test/           MOD  — new fixtures/assertions (see §13)
```

---

## 6. Module & Function Definitions (contract-grade)

Every change below is a full contract block (signature, Purpose, Params, Returns, Side effects, Error cases, Called by, Calls). Cross-reference integrity is enforced: each **Called-by** has the matching **Calls** on the other side.

### 6.A — Capture subsystem (Issues #2, #3)

#### C1 — `snapshotForecasts` / `snapshotEnsembles`: fail-loud on empty station set
**Target:** `supabase/functions/snapshot-forecasts/handler.ts:38-44`; `snapshot-ensembles/handler.ts:28-31`.

```
snapshotForecasts(ctx: JobCtx, deps: SnapshotDeps): Promise<JobStats>   // MODIFIED
  Purpose (unchanged §6.14): capture multi-model daily tmax per active station + gap-fill.
  CHANGE: after `const stations = await db.rpc<Station>('list_active_stations', {})` (handler.ts:40):
      log('capture inputs', { stations: stations.length, models: models.length });
      if (stations.length === 0) {
        throw new JobInputError(
          'list_active_stations returned 0 rows at runtime — refusing to record an empty ok run '
          + '(period would be permanently consumed as already_ran). Universe is non-empty '
          + 'server-side (45); this is the deployed-isolate capture defect (#2).');
      }
  Params: ctx {db,config,log,startedAt}; deps {fetchJson,notify,slot,now,omForecastBase,
          omPreviousRunsBase,apiKey?}. UNCHANGED.
  Returns: JobStats { stations, stationsFailed, rowsUpserted, gapsRepaired, modelsMissing[] }.
          Shape UNCHANGED; the empty case no longer reaches the return.
  Side effects: on empty stations THROWS → runJob records job_runs.status='failed' + error
          + Slack JOB_FAIL (runJob.ts:106-123); the period becomes retryable via claim_job_run
          taken_over (0011:62-79). Non-empty path unchanged (per-station upsert, gap-fill).
  Error cases: NEW JobInputError on empty stations (caught by runJob, never rethrown past it).
          Per-station UpstreamError unchanged (skip station, collect, WARN >20%).
  Called by: runJob (snapshot-forecasts/index.ts:20 → runJob.ts:97); adminTriggerJob (trigger-job).
  Calls: db.rpc('list_active_stations') (_shared/db.ts:31); db.rpc('list_enabled_models');
          JobInputError (packages/core, NEW); log; forecastUrl; parseMultiModelDaily; leadDays;
          db.rpc('upsert_forecast_rows'); db.rpc('bump_model_null_streak');
          db.rpc('forecast_gap_matrix'); previousRunsUrl; parsePreviousRunsHourly; deps.notify.
```
`snapshotEnsembles` gets the identical guard after `handler.ts:28-31`, placed BEFORE the models fetch. `JobInputError` is a new named `Error` subclass exported from `packages/core` so runJob's `e.name: e.message` formatting (`runJob.ts:107`) yields a clean Slack line.

#### C2 — `supabasePort(client).rpc<T>`: log raw null-vs-`[]` on empty SETOF
**Target:** `supabase/functions/_shared/db.ts:31-41` (`supabasePort.rpc`, normalization at `:40`).

```
supabasePort(client).rpc<T>(fn, args): Promise<T[]>   // MODIFIED (diagnostic only)
  Purpose (unchanged): call a migration SQL fn via PostgREST, normalize to row-array shape.
  CHANGE: keep the EXACT mapping at db.ts:40
      `Array.isArray(data) ? data : data === null ? [] : [{ [fn]: data }]`,
      but when the result is the fabricated-empty branch
      (data === null OR (Array.isArray(data) && data.length === 0)) emit ONE structured log:
          console.log(JSON.stringify({ rpc: fn, empty: true, dataWasNull: (data === null) }));
      — so the deployed isolate records WHETHER PostgREST sent null (no rows) vs [] (empty SETOF)
      for the failing call.
  Params / Returns: UNCHANGED — callers still receive T[].
  Side effects: adds a console.log on empty results only (negligible). NO throw added here
          (the throw lives in C1 — db.ts stays a pure transport).
  Error cases: UNCHANGED — still throws ConfigError on PostgREST error (db.ts:33).
  Called by: every edge handler via ctx.db.rpc; runJob.ts (claim_job_run/complete_job_run).
  Calls: client.rpc (npm:@supabase/supabase-js@2).
```
**Boundary:** the web twin `apps/web/src/lib/port.ts:23` has the identical mapping but is deliberately NOT touched (read-only RSC tier, out of subsystem).

#### C3 — Dead-man halt lifecycle: does NOT auto-clear (corrects DATA-LAYER-REVIEW.md:88)
**Target:** `health-monitor/handler.ts` (apply path) + `0013_grading_rpcs.sql:224` (`apply_halt`) + `0021_operator_rpcs.sql:66` (`operator_resume`).

```
DEAD-MAN HALT LIFECYCLE (as-built, corrected against source):
  apply_halt(p_scope, p_reason) [0013:224]
      — UPSERTs config['halt:'||scope] = {reason,at} + config_audit(actor='system').
        It ONLY writes (verified 0013:233-238); there is NO delete branch.
  health-monitor [handler.ts] — re-runs evaluateBreakers each pass; if the forecast is still
        stale it calls apply_halt AGAIN (idempotent overwrite). There is NO branch that DELETEs
        halt:global on recovery (verified — no delete-on-recovery in the handler).
  operator_resume(p_halt_key) [0021:66] — THE ONLY removal path: operator_guard();
        `delete from config where key = p_halt_key returning value` (0021:77);
        config_audit actor='admin-ui'. Manual, from /admin.

CONSEQUENCE: once #2 (C1/C2) lands and forecasts go fresh, health-monitor merely STOPS
  re-applying the halt — the EXISTING config['halt:global'] row PERSISTS and
  poll-markets halted() (handler.ts:186-189) keeps returning true for every event until an
  operator clears it.

FIX (Phase 2, operational, no code REQUIRED): after confirming fresh non-backfill forecasts,
  clear via the existing operator_resume('halt:global') (admin "Resume").

OPTIONAL (Phase 3 hardening, migration 0030_clear_system_halt.sql): add a recovery branch in
  health-monitor that, when freshestForecastAgeH < staleForecastHaltH AND a SYSTEM-authored
  halt:global exists, calls a NEW clear_system_halt('global') RPC that DELETEs ONLY when
  config_audit shows the last writer was 'system' — so it NEVER auto-clears an operator halt.
  Audited actor='system-recover'. Symmetrical to apply_halt.
```
**Called by / reads:** `poll-markets halted()` reads `config['halt:global']` (handler.ts:187); `dash_admin_state` 'halts' aggregate renders it in `/admin`; `go_live_gate_inputs` reads halts (OUT OF SCOPE trading gate, untouched).

### 6.B — House-build subsystem (Issue #1 gate-A, Issue #4 analytics half)

#### HD-1 / DF-1 — `list_buildable_events()`: drop `cs.verified = true`
**Target:** NEW `0028_analytics_decouple.sql`, replacing `public.list_buildable_events()` at `0016_distribution_rpcs.sql:4-14`.

```sql
-- 0028_analytics_decouple.sql — decouple the HOUSE BUILD from the trading verified gate
-- (DATA-LAYER-REVIEW #1/#4, ADR-18). The build writes bucket_probabilities (pure analytics);
-- it never places a bet. `verified`/`betting_enabled` continue to gate ONLY the bet/candidate
-- path (poll-markets/handler.ts:302-305, edge.ts:99 — UNCHANGED).
create or replace function public.list_buildable_events()
returns table (event_id uuid)
language sql security definer set search_path = public
as $$
  select me.id
  from market_events me
  join city_stations cs on cs.city_id = me.city_id and cs.valid_to is null
  where me.closed = false and me.winning_bucket_idx is null and me.ladder_ok = true;
$$;
```
```
list_buildable_events() RETURNS TABLE(event_id uuid)   // MODIFIED (drop `and cs.verified=true`)
  Purpose: enumerate every open, ungraded, ladder-ok market_event with a CURRENT station mapping,
           for the ANALYTICS house build — independent of operator verification.
  Params: none.  Returns: one row per buildable event (live: 0 today → 100 after this change,
           across 44 distinct ICAOs — both live-verified).
  Side effects: none (read-only SQL, security definer).
  Error cases: none; an event whose city has no current city_stations row drops out (inner join on
           valid_to is null). ladder_ok=false / closed / graded events excluded by design.
  Why the city_stations join STAYS: get_build_inputs reads cs.icao for the same current mapping; an
           event with no station has no ICAO to fetch forecasts for — it could never build anyway.
           Keeping the join (minus verified) means list_buildable_events and get_build_inputs agree
           on the buildable set.
  Called by: build-distributions/handler.ts:6 (buildDistributions §6.16) — the ONLY caller
           (whole-repo grep); run-calibration tail via buildDistributions (handler.ts:475).
  Calls: none.
```

#### HD-2 — `buildDistributions` / `buildDistributionForEvent` docstrings (intent durability, no behavior)
**Target:** `build-distributions/handler.ts:1` docstring; `_shared/distributions.ts:1-6` module docstring; ARCHITECTURE.md §6.16 lines 1142, 1162.

```
buildDistributions(ctx, deps): Promise<JobStats>   // DOC ONLY — no code edit
  Purpose: for every event returned by list_buildable_events() (now: open, ungraded, ladder-ok —
           VERIFICATION NO LONGER REQUIRED, analytics build), call buildDistributionForEvent and
           sum written/skipped.
  Params: ctx (JobCtx: db,config,log); deps (BuildDeps: notify,now).
  Returns: JobStats { events, written, skipped }.
  Side effects: writes bucket_probabilities house_gaussian/house_ensemble rows via
           upsert_distribution (idempotent on inputs_hash).
  Error cases: per-event DistributionError caught inside buildDistributionForEvent
           (distributions.ts:168-171,194-197) → WARN, not fatal; the loop continues.
  Called by: runJob (build-distributions cron); adminTriggerJob; discover-markets tail-call
           (buildDistributionForEvent directly, ADR-16 seed).
  Calls: list_buildable_events (HD-1); buildDistributionForEvent (distributions.ts:51).
  VERIFIED no handler code edit needed: build-distributions/handler.ts loops over the RPC result
           with no verified check of its own — the only behavioral lever is the RPC body (HD-1).
```
Records intent so a future reader does not re-add the verified gate (ARCHITECTURE.md:1142 "verified station" is the trap that produced the bug → amend to "open, ungraded, ladder-ok event").

#### HD-3 — `get_build_inputs` backfill exclusion is CORRECT and UNCHANGED (boundary marker)
**Target:** `0016_distribution_rpcs.sql:40` (forecasts), `:56` (ensembles) — **NO CHANGE proposed**.

```
get_build_inputs(p_event_id uuid) RETURNS jsonb   // UNCHANGED
  Purpose: one round-trip bundle (event, city, icao, buckets, forecasts, stats, ensembles,
           intraday, lift) for one build.
  The forecasts sub-select (0016:32-43) correctly keeps `fs.snapshot_slot <> 'backfill'` (:40);
           same for ensembles (:56). W19 "backfill never feeds live builds" (§6.16:1162) is a
           DELIBERATE, correct rule.
  Why NOT relaxed: backfill rows carry captured_at = the backfill RUN instant (recent), NOT the
           historical forecast issue time. Feeding them to a current-target LIVE build would
           produce a distribution dated to stale information and corrupt ADR-16 time-matching.
           The fix is to make CAPTURE write non-backfill 10Z/22Z rows (Phase 2, C1/C2), NOT to
           drop the exclusion.
  Verified physical readiness: once non-backfill rows land, get_build_inputs returns them via the
           existing forecast_snapshots index on (icao, target_date); the <> 'backfill' filter is a
           cheap residual on the same scan. No new index needed.
  Called by: buildDistributionForEvent (distributions.ts:57) — SOLE caller (whole-repo grep).
  Calls: none.
```
**Sequencing boundary (state to operator):** BOTH HD-1 (de-gate, Phase 3) AND the capture fix (Phase 2, C1/C2) are required for the first `house_gaussian` row — neither alone is sufficient. HD-1 alone makes 100 events "buildable" but `get_build_inputs` still returns `forecasts=[]` → `distributions.ts:137` skips → `written=0`. The capture fix alone leaves Gate A blocking.

#### DF-2 (OPTIONAL) — `get_build_inputs(p_event_id, p_allow_backfill boolean default false)`
**Target:** `0028_analytics_decouple.sql` (only if the operator wants to seed present/future open events from backfill before the live feed returns).

```sql
create or replace function public.get_build_inputs(p_event_id uuid,
                                                   p_allow_backfill boolean default false)
returns jsonb language sql security definer set search_path = public as $$
  ... identical to 0016:18 EXCEPT the two predicates become
      `and (p_allow_backfill or fs.snapshot_slot <> 'backfill')`
      `and (p_allow_backfill or es.snapshot_slot <> 'backfill')` ...
$$;
```
```
get_build_inputs(p_event_id uuid, p_allow_backfill boolean default false) RETURNS jsonb // OPTIONAL
  Purpose: assemble every build input in one round trip. p_allow_backfill=true makes backfill-slot
           rows eligible as the latest-per-model row.
  DEFAULT false keeps the LIVE path bit-identical — only an analytics caller passes true.
  Side effects: none. Backward-compatible (PostgREST resolves by name; no other caller passes args).
  Called by: distributions.ts:57 (sole caller). Calls: none.
  RISK (information-time-matching): backfill captured_at is recent, NOT the historical issue time,
           so a LIVE build from backfill is NOT information-honest for a PAST target. p_allow_backfill
           MUST be used ONLY for target_date >= today (seeding open events) OR the offline scorer (DF-5)
           — NEVER to retro-build resolved events that score_distributions then grades.
```

#### DF-3 (OPTIONAL, pairs with DF-2) — `buildDistributionForEvent(..., opts: { allowBackfill?: boolean } = {})`
**Target:** `_shared/distributions.ts:51-62`.

```
buildDistributionForEvent(db, cfg, eventId, deps, opts: {allowBackfill?:boolean} = {})
                                                  : Promise<{written:number; skipped:number}> // OPTIONAL
  CHANGE: forward p_allow_backfill: opts.allowBackfill ?? false to get_build_inputs (DF-2).
  Params: + opts.allowBackfill (default false). Returns/Errors: unchanged.
  Side effects: writes bucket_probabilities via upsert_distribution (unchanged); only changes which
           forecast rows feed mu/sigma.
  Called by: build-distributions/handler.ts:10; discover-markets (ADR-16 seed); metar-nowcast
           (nowcast rebuild) — all three compile unchanged (trailing optional object).
  Calls: get_build_inputs (DF-2); upsert_distribution (0016:76); gaussianBucketProbs / ensembleStats
           / dressedEnsembleProbs (core).
  RISK: build-distributions should pass allowBackfill:true ONLY for target_date >= today, OR keep the
           live job on false and let DF-5 own all backfill-based scoring (preferred — keeps the live
           scoring path information-honest).
```

### 6.C — Edge-audit subsystem (Issue #5, Issue #4 audit half)

#### EDGE-1 / DF-4(A) — analytics edge pass over ALL open events with a champion
**Target:** `poll-markets/handler.ts` — new block between the candidate loop (ends ~384) and step (7) expiry (~476); reuses `computeBucketEdges` (NO `applyLiquidityFilters`).

```
auditEdgesForOpenEvents(...) — inline in pollPass   // NEW analytics pass
  Purpose: compute the PURE model-vs-market edge (computeBucketEdges only, NO liquidity vetoes)
           for EVERY open event that has a champion distribution, and merge those rows into
           edgeRowsByEvent so step (8) persists them. This is the analytics time-series:
           q (model prob) vs execAsk (Polymarket) per bucket per hour.
  Preconditions per event: evCtx && !closed && !graded && evCtx.buckets?.length>0
           && evCtx.champion != null && champion freshness <= CHAMPION_FRESH_MS
           && lead in [0, cfg.maxLeadDays].
           NO verified, NO bettingEnabled, NO halted, NO acceptingOrders gate (those stay on the
           recommendation path).
  Per event:
      q = evCtx.champion.probs.map(Number)
      ladder = evCtx.buckets.map(b => ({low:b.low, high:b.high, unit:evCtx.unit}))
      books REUSE whatever was already fetched in the candidate loop; non-candidate events fetch NO
           new book (budget MAX_BOOKS_PER_CYCLE=15 unchanged) → computeBucketEdges receives
           books=[null,...] → rows carry reasons=['no_book'] (honest: model prob existed, no live
           book this tick).
      marketRows mapped from parsed (same feeRate/spread/bestAsk mapping as handler.ts:314-324)
      rows = computeBucketEdges(q, ladder, books, marketRows, edgeCfg)   // §6.7 — NO liquidity filters
      If edgeRowsByEvent already has this event (it was bettable) → KEEP existing rows (same
           computeBucketEdges core; do not double-insert). Else set it.
  Side effects: mutates edgeRowsByEvent (in-memory only). NO DB writes here — step (8) writes.
  Returns: void (count surfaced via stats.evaluationsPersisted at step 8).
  Error cases: champion.probs length != buckets length ⇒ skip event + log (defensive guard).
  Called by: pollPass (poll-markets/handler.ts).
  Calls: computeBucketEdges (packages/core/src/edge.ts:37); leadDays; dateISO (handler.ts:110);
           localDayWindow (spread/fee mapping reuse).
  RATIONALE for computeBucketEdges-only: applyLiquidityFilters injects station_unverified /
           volume_below_min / halted (edge.ts:96-100) — trading vetoes that would mark EVERY
           analytics row pass=false and poison the "did the model have an edge" signal. The dashboard
           display recompute (edge-display.ts:96-116) ALSO runs computeBucketEdges-only, so stored
           analytics rows match the recompute exactly on the compared fields (q/execAsk/edge/minEdge)
           — the §15 no-drift check stays green.
```

#### EDGE-2 / DF-4(B) — drop the `getUTCMinutes() < 5` clock gate; persist every tick
**Target:** `poll-markets/handler.ts:512`.

```
Step (8) AUDIT — REVISED gate
  BEFORE: if (deps.now.getUTCMinutes() < 5 && edgeRowsByEvent.size > 0) { persist }
  AFTER:  if (edgeRowsByEvent.size > 0) { persist }     // every tick; idempotency does the dedup
  hour = truncate(now) to the hour (UNCHANGED: hour.setUTCMinutes(0,0,0) at handler.ts:513-514)
  auditRows = flatten edgeRowsByEvent → {event_id, bucket_idx, captured_hour: hour.toISOString(),
                                         q, exec_ask, edge, min_edge, pass, reasons}
  n = persist_edge_evaluations(auditRows)   // UNCHANGED RPC (0018:211); on conflict
                                            // (event_id,bucket_idx,captured_hour) DO NOTHING (0018:225)
  stats.evaluationsPersisted = n            // first tick of an hour returns N>0; later ticks that
                                            // hour return 0 (already inserted) — correct
  Idempotency proof: captured_hour is hour-truncated → all ticks in hour H write captured_hour=H.
    The first tick inserts; later ticks hit the unique index and DO NOTHING. Net rows per
    (event,bucket,hour) = exactly 1. Row count + 30d retention bound UNCHANGED.
  WHY operationally: the live poll cron is '15 10,22' (minute 15) → getUTCMinutes()=15 is NEVER < 5,
    so under the old gate the audit NEVER fired on the scheduled runs. The clock gate wasn't
    'once an hour', it was 'never on the real schedule'.
  X-3b CORRECTION: 'every tick' makes the audit RELIABLE, NOT denser. Sub-hour densification would
    require captured_hour=tick-timestamp + a changed unique key + retention/dash-read changes —
    a separate, larger change (operator decision; see §3).
  Called by: pollPass (handler.ts) — same call site, gate relaxed.
  Calls: persist_edge_evaluations (0018:211) — UNCHANGED.
```

#### EDGE-3 — invariant: `bettable` gates the bet path ONLY (guard-rail spec, NO code change)
**Target:** `poll-markets/handler.ts:302-305` (the `bettable` predicate).

```
INVARIANT (enforced by EDGE-1/EDGE-2, asserted by a regression test):
  The `bettable` predicate (verified && bettingEnabled && acceptingOrders && !halted) gates ONLY:
    - the candidate/screen/book-fetch loop (handler.ts:299-361)
    - sizing (jointKellyStakes) + applyRiskCaps (388-413)
    - upsert_recommendation / bets writes (442-450)
    - expire_recommendation / live cancel (490-499)
    - applyLiquidityFilters station_unverified veto (377 → edge.ts:99)
  It must NOT gate:
    - the analytics edge audit (EDGE-1) — runs over ALL open events with a champion
    - persist_edge_evaluations (EDGE-2)
  Rationale: analytics/decision-support tool; verified/betting_enabled are live-trading gates
    (Issue #4). The model-edge time-series is paper-safe and recorded regardless. No bets/fills can
    result from the audit path — it writes only edge_evaluations (a read-only analytics sink; no
    FK to bets, no write path to bankroll — verified 0005:99-111).
  Regression lock: a test inserting an UNVERIFIED, betting_disabled OPEN event WITH a champion + a
    book asserts edge_evaluations gets a row whose pass/reasons reflect ONLY model-edge reasons
    (no_book/edge_below_min/insufficient_depth) — NOT station_unverified.
```

### 6.D — Dashboard subsystem (Issues #6, #7)

#### WEB-1 — `dash_events_list(p_champion text)` (NEW RPC)
**Target:** `0029_dashboard_events_list.sql`.

```sql
public.dash_events_list(p_champion text) returns jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
```
```
dash_events_list(p_champion text) RETURNS jsonb   // NEW
  Purpose: one round trip returning every OPEN market_event with collection-health columns — the
           operator sees at a glance what data has/has not been collected per event (analytics only).
  Guard: perform public.operator_guard();  (raises ERR_FORBIDDEN if not is_operator() — 0021:7-18,
           FIRST statement, mirrors 0022:14)
  Returns jsonb: {
    events: [ {
      slug, city (cities.display_name), citySlug, targetDate,
      acceptingOrders bool, ladderOk bool, closed bool (always false here),
      nBuckets int,                       -- count(market_buckets) for event
      lastSnapshotAt timestamptz|null,    -- max(market_snapshots.captured_at) over event's buckets
      lastConsensusAt timestamptz|null,   -- max(bucket_probabilities.made_at) where source='market_consensus'
      hasHouse bool,                      -- exists bucket_probabilities where source <> 'market_consensus'
      volume24h numeric                   -- me.volume24h (display only)
    } ... ],
    champion: text (config.championSource),
    counts: { open, withSnapshot, withConsensus, withHouse, withLadder }   -- header roll-up
  }
  Query: FROM market_events me JOIN cities c ON c.id=me.city_id WHERE NOT me.closed
         ORDER BY me.target_date, c.display_name. Per-event LEFT-correlated subselects mirror the
         dash_event_detail idiom (0022:81-108) verbatim. Health columns INDEPENDENTLY nullable
         (live: some events have lastSnapshotAt set but lastConsensusAt null).
  Side effects: none (read-only).
  Called by: getEventsList loader (WEB-2).
  Calls: operator_guard() (0021:7-18).
  LIVE-VERIFIED: the per-event shape returns all 119 open events;
           counts = {open:119, withSnapshot:116, withConsensus:114, withHouse:0, withLadder:116}.
```

#### WEB-2 — `getEventsList` loader + `EventsListView` / `EventListRow` types (NEW)
**Target:** `apps/web/src/lib/loaders.ts`.

```
export interface EventListRow {
  slug: string; city: string; citySlug: string; targetDate: string;
  acceptingOrders: boolean; ladderOk: boolean;
  nBuckets: unknown; lastSnapshotAt: string | null; lastConsensusAt: string | null;
  hasHouse: boolean; volume24h: unknown;
}
export interface EventsListView {
  events: EventListRow[]; champion: string;
  counts: { open: unknown; withSnapshot: unknown; withConsensus: unknown;
            withHouse: unknown; withLadder: unknown };
}
export async function getEventsList(db: WebDb): Promise<EventsListView>   // NEW
  Purpose: load the open-events collection-health table for the /events index page.
  Params: db: WebDb (RLS-scoped session port).
  Returns: EventsListView (events default [] when RPC null — mirror getCalibrationView 269-274).
  Side effects: one RPC round trip (dash_events_list).
  Error cases: rpc() throws on PostgREST error (port.ts:24-26); ERR_FORBIDDEN propagates as a thrown
           Error for a non-operator (defense-in-depth behind the layout guard).
  Called by: EventsIndexPage (WEB-3).
  Calls: one<EventsListView>(db,'dash_events_list',{p_champion: cfg.championSource}) via
           loadConfig + one (loaders.ts:15-22).
  NOTE: numeric fields typed `unknown` (jsonb-string-safe) per the file convention (e.g. OpenRec.q
           at loaders.ts:31); the page coerces with num()/fmtUsd.
```

#### WEB-3 — `/events` index landing page (NEW)
**Target:** `apps/web/src/app/(dash)/events/page.tsx`.

```
export const dynamic = 'force-dynamic';
export default async function EventsIndexPage(): Promise<ReactElement>   // NEW
  Purpose: the analytics landing — list all open events with collection-health columns, each row
           linking to /events/[slug] and /city/[citySlug].
  Reads: getEventsList(await serverDb()) (WEB-2).
  Renders:
    - <h1>Open events <chip>{counts.open} open</chip></h1>
    - header roll-up: 'snapshots {withSnapshot}/{open} · consensus {withConsensus}/{open}
      · model {withHouse}/{open} · ladders {withLadder}/{open}'
    - table: city | target | status(accepting/closed chip) | ladder(ok/flagged) | buckets
      | last snapshot (fmtAgo) | last consensus (fmtAgo) | model? (chip: pending|built)
      with the city cell → <a href={`/events/${slug}`}> and a → /city/{citySlug} link.
    - empty state: 'No open events right now — discover-markets seeds them.'
  Side effects: none.
  Called by: Next.js App Router (route group (dash), path /events). Linked from nav (WEB-4) + brand.
  Calls: getEventsList() (WEB-2); serverDb() (supabase.ts:52-54); fmtAgo/fmtDate/fmtUsd/num (format.ts).
  ROUTING: introduces events/page.tsx as a SIBLING of events/[slug]/page.tsx — App Router resolves
           /events → page.tsx and /events/{slug} → [slug]/page.tsx with no collision (verified: only
           events/[slug]/page.tsx exists under events/ today).
  MODEL? column makes the universal model-pending state legible: live, every row reads 'pending'
           (hasHouse=false for all 119) — the headline diagnostic. Driven purely by live hasHouse,
           flips to 'built' automatically once HD-1 + capture land.
```

#### WEB-4 — add `/events` nav link
**Target:** `apps/web/src/app/(dash)/layout.tsx:13-19`.

```
const NAV = [
  ['/events', 'events'],   // NEW — analytics landing (open events + collection health)
  ['/', 'today'],
  ['/calibration', 'calibration'],
  ['/bets', 'bets'],
  ['/system', 'system'],
  ['/admin', 'admin'],
] as const;
  Purpose: make /events reachable from every page (fixes finding #6's "rich data unreachable").
  Called by: DashLayout render (layout.tsx:27-31 .map → Link). NO other reader of NAV.
  Calls: none.
  (Optional, cosmetic: point the brand <span> at layout.tsx:26 at /events too — see ADR sign-off.)
```

#### WEB-5 / DF-6 — make `/calibration` source list DATA-DRIVEN
**Target:** `apps/web/src/app/(dash)/calibration/page.tsx:17,31-34,42-44`.

```
REMOVE: const SOURCES = ['house_gaussian','house_ensemble'] as const;   (line 17)
DERIVE instead from the loaded rows:
  const sources = [...new Set(v.scores.map((r) => r.source))].sort();
  // reliability diagrams: one per source that actually has scored rows  (replaces 31-34)
  {sources.map((s) => <ReliabilityDiagram key={s} title={s} points={shapeReliability(bySource(s))} />)}
  // promotion buttons: only HOUSE challengers vs the consensus baseline, never consensus itself
  const PROMOTABLE = new Set(['house_gaussian','house_ensemble']);       (replaces 42-44)
  {sources.filter((s) => s !== v.champion && PROMOTABLE.has(s)).map((s) => <PromoteButton key={s} source={s} />)}
  Purpose: the reliability section currently renders ONLY the 2 house sources (no reliability bins
           live) and hides all 45 scored market_consensus reliability rows. Deriving from v.scores
           surfaces the market_consensus reliability diagram (it has reliability jsonb).
  PROMOTABLE guard preserves F-019 invariant: consensus is the BASELINE, never a promotion target —
           adminPromoteSource (routes.ts:251) still only ever sees house_* (unchanged, correct).
  Scores table (lines 67-90) is ALREADY data-driven (iterates v.scores) — no change there.
  Called by: CalibrationPage render.
  Calls: shapeReliability() (shapers.ts:30-48 — already skips rows without a reliability array, so a
           derived source with empty bins renders 'No reliability data stored yet', no crash);
           v.scores from getCalibrationView (loaders.ts:269-274); PromoteButton (controls.tsx).
  NO RPC/schema change — dash_calibration (0022:210-233) ALREADY returns every source.
  LIVE-VERIFIED: 45 market_consensus + 2 house_gaussian calibration rows exist → post-change the
           reliability section shows a market_consensus diagram immediately.
```

#### WEB-6 / DF-6 — explicit MODEL-PENDING state on `/events/[slug]`
**Target:** `apps/web/src/app/(dash)/events/[slug]/page.tsx:45-58` + `components/DistributionOverlay.tsx:22-37`.

```
DistributionOverlay (DistributionOverlay.tsx):
  add prop `modelPending?: boolean` (true when consensus present but house absent).
  - when houseProbs===null && consensusProbs!==null: render market bars (as today) PLUS a visible
    note <p className='chip amber'>model distribution not built yet — showing market consensus
    only</p> and SUPPRESS the 'house q' legend swatch (only show 'market p').
  - when both null: UNCHANGED 'No distributions stored yet'.

events/[slug]/page.tsx:
  - header (line 45): when detail.houseDist===null render
    <h2>Distributions — market consensus <span className='chip amber'>model pending</span></h2>
    instead of '{championSource} vs market consensus'.
  - pass modelPending={!detail.houseDist && !!detail.consensusDist} to DistributionOverlay (line 47-53).
  - caption (lines 54-58): when houseDist===null render 'house distribution pending — model side
    (house_gaussian/house_ensemble) not yet built for this event' instead of the μ/σ '—' line.
  Purpose: stop implying a house overlay exists when 0/119 events have one.
  NO loader/RPC change — dash_event_detail ALREADY returns houseDist (0022:90-96, source=p_champion)
           + consensusDist (0022:97-102). recomputeEdgeRows already returns null when houseDist is
           null (edge-display.ts:96-97) so EdgeChart correctly shows nothing — leave it; the mid-price
           spark (page.tsx:67-70) already works.
  Called by: EventPage render (events/[slug]/page.tsx); CityPage render (city/[slug]/page.tsx:43-51,
           also uses DistributionOverlay — one-line follow-on to pass modelPending, same null-house
           condition; optional prop keeps it compiling unchanged).
  Calls: DistributionOverlay (DistributionOverlay.tsx); getEventDetail (loaders.ts:183-193).
```

### 6.E — Scoring subsystem (Issue #1 model side, the grow-over-time deliverable)

#### DF-5 — grow scored model-vs-market history via the existing `simulate-historical-edge`
**Target:** `scripts/simulate-historical-edge.ts` (NO code change) + a `backfill-market-history` prerequisite (ops step) + `calibration_scores window_tag='backtest'`.

```
NO new function. Operational wiring of the already-built, already-tested simulate-historical-edge
(§6.22) so calibration_scores accrues a real house-vs-market Brier history WITHOUT placing bets:

  pnpm tsx scripts/simulate-historical-edge.ts --from <archive_start> --to <today-2> \
        --source house_gaussian --out reports

  Precondition it ENFORCES: backfilled market_consensus rows must exist at PRE-CUTOFF made_at
  timestamps. Live DB has none (consensus min_made_at = 2026-06-12; calib_backtest = 0 live), so the
  missing ops input is `backfill-market-history` (§9.7, ARCHITECTURE.md:2037) synthesizing consensus
  rows from Polymarket prices-history at the ADR-16 cutoffs.

  Once present, the walk builds house_gaussian at cutoff(L)=startUtc − L·24h from snapshot_slot=
  'backfill' forecasts, scores vs winningBucket actuals, time-matches against backfilled consensus
  (made_at <= cutoff), and writes calibration_scores(window_tag='backtest', per city+lead). THIS is
  the information-honest scored history (no-peeking), NOT a live retro-build.
  Called by: operator CLI (and, optionally, a future scheduled ops wrapper).
  Calls: db over forecast_snapshots/observations/bucket_probabilities/market_buckets;
         computeBucketEdges/brierScore/fitSigma/updateBias (core);
         calibration_scores insert window_tag='backtest'.
  ISOLATION: go_live_gate_inputs reads ONLY window_tag='60d' (0019), so backtest rows do NOT leak
         into the (out-of-scope) live gate — correct (backtest is indicative-only).
  RISK (information-time-matching, central): the script handles cutoffs correctly; the HAZARD is the
         PREREQUISITE — backfill-market-history MUST stamp synthesized consensus made_at = the
         historical pre-cutoff timestamp (from prices-history), NOT now(). If now(), every backtest
         pair becomes a peek and the Brier is meaningless. Assert + spot-check.
```

---

## 7. Data Model & Migration Changes

### 7.1 Migration `0028_analytics_decouple.sql` (NEW)

- **`list_buildable_events()`** — `CREATE OR REPLACE`, drops only the `and cs.verified = true` conjunct (was `0016:12`). No table/column/index change.
  - **Sole caller (whole-repo grep):** `build-distributions/handler.ts:6` (+ run-calibration tail at handler.ts:475 via `buildDistributions`).
  - **Every reader of `city_stations.verified` enumerated:** (1) `0016:12` `list_buildable_events` — THIS change removes it; (2) `0018:49` `poll_known_events` → `ctx.verified`; (3) `poll-markets/handler.ts:303` `bettable` gate AND `:366/:368` `liquidityCtx.stationVerified`/`stationVerified` → `edge.ts:99` `station_unverified` — **out-of-scope bet path, LEFT INTACT**; (4) `0021` `operator_verify_station` writer, LEFT INTACT. No analytics reader other than `list_buildable_events` depends on `verified`. Contained.
- **`get_build_inputs`** — **UNCHANGED by default** (backfill exclusion stays, W19). Optional `p_allow_backfill boolean default false` param (DF-2) is backward-compatible by name; sole caller `distributions.ts:57`.

**Every downstream reader of the `bucket_probabilities` house rows that newly appear** (all enumerated; NONE break — all coalesce/filter by source, none do an unguarded typed-destructure on a new source value):
- `load_known_events_for_poll` (`0024_fix_poll_known_events_buckets.sql:54`) — latest non-nowcast house row; currently null, will populate; bet still gated by `bettable` at `handler.ts:302`, so no bet leaks.
- `grade-bets` stamping (`0013_grading_rpcs.sql:141-175`) — iterates distinct `bp.source` per event; now includes `house_gaussian`, writes its brier — **densifies scoring, intended**.
- `run-calibration` aggregation (`0017_calibration_rpcs.sql:240` `calib_scored_rows`) — reads scored rows.
- Dashboard RPCs: `dash_event_detail` (`0022:90-102` houseDist/consensusDist), `dash_city_detail` (`0022:145`), support RPCs (`0020`), market RPCs (`0018:243`), `operator_compare` (`0021:224,227`).
- `apps/web/src/lib/edge-display.ts:97` `recomputeEdgeRows` — currently returns null (houseDist null) → will return rows.

### 7.2 Migration `0029_dashboard_events_list.sql` (NEW)

- **`dash_events_list(p_champion text) RETURNS jsonb`** — read-only over `market_events` (§7.9), `market_buckets` (§7.10), `market_snapshots` (§7.11), `bucket_probabilities` (§7.12), `cities` (§7.1). Self-guards with `operator_guard()` (ERR_FORBIDDEN, first statement). **Zero existing readers of its output shape** — only `getEventsList` (WEB-2) + `/events` page (WEB-3), both new. No new column → nothing to break.
- **Indexes leaned on (confirmed to exist):** `market_snapshots (bucket_id, captured_at desc)` (§7.11, ARCHITECTURE.md:1673-1674); `bucket_probabilities (event_id, source, made_at desc)` = `bucket_probabilities_event_source_time_idx` — **literally verified at `0005_analytics.sql:27-28`** (see correction below). For 119 events on a `force-dynamic` page the per-event correlated subselects are acceptable; fold into a single LATERAL pass only if it ever regresses (noted, not needed now).

### 7.3 Migration `0030_clear_system_halt.sql` (NEW, Phase-3 OPTIONAL)

- **`clear_system_halt(scope text)`** — DELETEs `config['halt:'||scope]` **only when `config_audit` shows the last writer was `'system'`**; audited `actor='system-recover'`; symmetrical to `apply_halt` (`0013:224`). NEVER deletes an operator-authored halt. Every `config['halt:*']` reader enumerated: `poll-markets halted()` (`handler.ts:186-189`), `dash_admin_state` halts aggregate, `go_live_gate_inputs` (OUT OF SCOPE), `operator_resume`/`operator_halt` (`0021`). Only adopt if the operator wants auto-recovery; otherwise the Phase-2 manual `operator_resume('halt:global')` (zero code) suffices.

### 7.4 NO schema change for the edge audit

`edge_evaluations` table (`0005_analytics.sql:99-111`), its unique index `edge_evaluations_natural_key (event_id, bucket_idx, captured_hour)` (`0005:113-114`), the `persist_edge_evaluations` upsert (`0018:211-229`, `on conflict … do nothing` at `:225`), and the 30-day retention prune (downsample cron, `0009`) are **ALL unchanged and already correct** for the every-tick idempotent cadence. The unique key was opened and confirmed to **literally exist**, to match the RPC's on-conflict target, to match `migrations.test.ts:108`, and to be the key the dashboard reader relies on.

### 7.5 C1 — `job_runs` row OUTCOME change (no shape change)

The pathological empty-station case changes from `status='ok' + stats{stations:0}` to `status='failed' + error + stats=null`. Every `job_runs` reader enumerated: (a) `claim_job_run` (`0011:50,70`) — `failed` is retryable/taken_over (intended, the fix); (b) `reap_stale_runs` (`0020`) — acts only on `running`, no interaction; (c) `job_freshness` / health-monitor — a failing snapshot now correctly shows `failed`; (d) `dash_system_health` (`0022`) + `/system` page — renders status/stats verbatim, already null-tolerant; (e) Slack `JOB_FAIL` via `runJob.ts:117` — new alert fires (correct). No reader does an `Array.isArray`/typed-destructure on these stats that the null-stats shape breaks.

### 7.6 — INDEX CORRECTION (overriding spec 6's X-IDX claim)

> **Spec-6 X-IDX asserted:** "I did NOT find a dedicated `(event_id,source,made_at desc)` btree and flag it as unverified." **This is wrong.** Per the method's "OPEN THE MIGRATION and confirm it literally exists" rule, I opened `0005_analytics.sql`: the index **`bucket_probabilities_event_source_time_idx ON public.bucket_probabilities (event_id, source, made_at desc)` literally exists at lines 27-28.** It already supports `score_distributions`' `made_at <= cutoff` lookup (`0013:147-152`), `poll_known_events`' latest-champion lookup (`0018:73`), and `position_watch`/`dash_event_detail` latest-per-source laterals. **No new index is required** for the latest-per-source read even after `house_gaussian` doubles the table. The two on-conflict natural keys (`bucket_probabilities (event_id, source, inputs_hash)` at `0005:25-26`; `edge_evaluations (event_id, bucket_idx, captured_hour)` at `0005:113-114`) also exist. No claimed index in this blueprint is unverified.

### 7.7 — `model_stats` coverage (honesty caveat, not a gate)

Live: `model_stats` = 10 distinct ICAOs, 1140 rows (leads 1-7, slots 10Z+22Z). `house_gaussian` does **NOT** require `model_stats`: `distributions.ts:143` uses `correctPoint(tmaxC, st?.bias ?? 0)` (zero bias when no stat), `:145-150` falls back to equal weights `1/forecasts.length`, and `blendSigmaC` (`:114-118`) falls back to `cfg.priorSigmaByLead[Math.min(lead,7)]` floored at `sigmaFloorC=0.45`. So `house_gaussian` builds for all 44 ICAOs once non-backfill forecasts exist — ~26 of 100 buildable events with refining stats, the other ~74 on the prior ladder (valid but uncalibrated until calibration densifies). No `model_stats` schema change.

---

## 8. Interface Contracts (each maps to a §6 function)

| Contract | Signature | Maps to §6 |
|---|---|---|
| **list_buildable_events RPC** | `list_buildable_events() → SETOF (event_id uuid)` (drops `cs.verified=true`) | HD-1 / DF-1 |
| **get_build_inputs RPC** | `get_build_inputs(p_event_id uuid[, p_allow_backfill boolean default false]) → jsonb` (optional param; default keeps live path identical) | HD-3 / DF-2 |
| **dash_events_list RPC** | `dash_events_list(p_champion text) → jsonb { events[], champion, counts{} }`; guard `operator_guard()` | WEB-1 |
| **persist_edge_evaluations RPC** | `persist_edge_evaluations(p_rows jsonb) → int` — **UNCHANGED** (`0018:211`, on-conflict-do-nothing) | EDGE-2 |
| **clear_system_halt RPC** (optional) | `clear_system_halt(scope text) → boolean` — deletes only `actor='system'` halts | C3 |
| **snapshot-forecasts job** | `runJob → snapshotForecasts(ctx, deps) → JobStats`; empty stations now → `job_runs.status='failed'` (retryable) instead of `ok` | C1 |
| **snapshot-ensembles job** | same empty-station guard | C1 |
| **poll-markets job (audit step)** | `pollPass` analytics edge pass + every-tick persist; `bettable` gates the bet path only | EDGE-1/2/3 |
| **getEventsList loader** | `getEventsList(db: WebDb) → Promise<EventsListView>` | WEB-2 |
| **getCalibrationView loader** | UNCHANGED shape; page derives `sources` from `v.scores` | WEB-5 |
| **getEventDetail loader** | UNCHANGED; page reads `houseDist`/`consensusDist` already returned (`0022:90-102`) | WEB-6 |
| **DistributionOverlay component** | gains optional `modelPending?: boolean` prop | WEB-6 |
| **db.ts rpc wrapper** | `rpc<T>(fn,args) → Promise<T[]>`; logs `{rpc,empty,dataWasNull}` on empty SETOF (diagnostic) | C2 |

---

## 9. Data Flow

### 9.1 The new analytics path (happy)

```
[Phase 2] pg_cron 10:15Z → snapshot-forecasts → runJob(202, waitUntil)
   → snapshotForecasts: stations = list_active_stations()   [C1: log cardinality; throw if 0]
   → for st in stations: forecastUrl → parseMultiModelDaily → upsert forecast_snapshots (slot '10Z', NON-backfill)
   → job_runs ok                                            [fresh non-backfill rows now exist]
   → operator clears halt:global via operator_resume        [C3: does NOT auto-clear]

[Phase 3] pg_cron 10:50Z → build-distributions → buildDistributions
   → list_buildable_events()  [HD-1: 100 events, no verified gate]
   → per event: buildDistributionForEvent → get_build_inputs (non-backfill forecasts present)
        → distributions.ts:137 length>0 TRUE → house_gaussian block (correctPoint, ensembleStats,
          gaussianBucketProbs; prior σ when no model_stats) → upsert_distribution('house_gaussian')
   → bucket_probabilities gains house_gaussian rows         [the model probability now EXISTS]

[Phase 1/3] pg_cron poll tick → poll-markets → pollPass
   → CONSENSUS: impliedDistribution(mids) → bucket_probabilities('market_consensus')   [already live]
   → CANDIDATE loop (bettable only) — bet path, UNCHANGED
   → auditEdgesForOpenEvents  [EDGE-1: ALL open events with a champion; computeBucketEdges, NO
                               liquidity vetoes; book reuse only → reasons=['no_book'] if none]
   → step (8): if (edgeRowsByEvent.size>0) persist_edge_evaluations  [EDGE-2: every tick, idempotent
                               on captured_hour → 1 row/(event,bucket,hour)]
   → edge_evaluations accumulates the model-vs-market edge TIME-SERIES

[Dashboard] /events (dash_events_list) → model? flips pending→built per live hasHouse
            /events/[slug] (dash_event_detail) → houseDist now non-null → DistributionOverlay shows
              both series; recomputeEdgeRows returns rows → EdgeChart renders; drift check green
            /calibration (dash_calibration) → derive sources → house_gaussian + market_consensus
              reliability diagrams
```

### 9.2 The scoring path (grow-over-time, information-honest)

```
[ops prerequisite] backfill-market-history → synthesize bucket_probabilities('market_consensus')
   with HISTORICAL made_at at ADR-16 cutoffs   [HAZARD: must NOT stamp now() — else every pair peeks]

operator CLI → simulate-historical-edge --source house_gaussian
   → walk-forward: build house_gaussian at cutoff(L)=startUtc − L·24h from backfill forecasts
   → score vs winningBucket actuals; time-match vs backfilled consensus (made_at <= cutoff)
   → calibration_scores(window_tag='backtest')   [isolated from go_live_gate_inputs which reads 60d only]

[live, forward] grade-bets on resolution → score_distributions per source (house_gaussian +
   market_consensus) at cutoff → bucket_probabilities.brier → run-calibration aggregates →
   calibration_scores(30d/60d/90d) → /calibration surfaces the growing Brier history
```

### 9.3 Error branches

- **Capture empty stations (C1):** `list_active_stations()` returns `[]` at runtime → `JobInputError` → `job_runs.status='failed'` + Slack JOB_FAIL → period retryable (NOT a silent `ok` wedge). C2 logs `{rpc:'list_active_stations', empty:true, dataWasNull:?}` → next run pins null-vs-`[]`.
- **House build with no forecasts:** `get_build_inputs.forecasts=[]` → `distributions.ts:137` skips → `written=0` (no crash). Resolves once C1/C2 land.
- **Analytics edge with no book:** non-candidate event → `books=[null]` → `reasons=['no_book']`, `execAsk=null` (honest; q-vs-mid still queryable from `market_consensus`).
- **Dashboard model pending:** `houseDist=null` → WEB-6 amber "model pending" note; `recomputeEdgeRows` returns null → EdgeChart empty (already honest, leave untouched).

### 9.4 Information-time-matching flags (the one comparison everything gates on — ADR-16)

- **De-gated build (HD-1):** widens the EVENT SET only; `gradeEvent` stamps the last `made_at ≤ cutoff` row for EACH source symmetrically → can only ADD matched pairs, never tilt. **Information-time-matched.**
- **DF-2 `p_allow_backfill=true` LIVE build:** **NOT information-time-matched** for a past target (backfill `captured_at` is recent) → restrict to `target_date >= today` or use only in the offline scorer. **FLAGGED.**
- **DF-5 backfill-market-history:** consensus `made_at` MUST be the historical pre-cutoff instant, not `now()` — else the backtest peeks. **FLAGGED, must assert.**
- **Live forward scoring:** `score_distributions` keys on `made_at ≤ cutoff` for both sources at the same cutoff — **matched by construction.**

---

## 10. Dependency Map (delta)

Edges ADDED or CHANGED (`A → B` = "A calls/depends on B"):

```
build-distributions/handler.ts  → list_buildable_events()         CHANGED (predicate; same edge)
buildDistributionForEvent       → get_build_inputs(…, allowBackfill?)  CHANGED (optional param; DF-2/3)
snapshotForecasts/Ensembles     → JobInputError (packages/core)    ADDED (C1)
supabasePort.rpc                → console.log diagnostic           ADDED (C2; no module dep)
poll-markets/pollPass           → auditEdgesForOpenEvents (inline) ADDED (EDGE-1)
auditEdgesForOpenEvents         → computeBucketEdges (core)        ADDED (reuse; NO applyLiquidityFilters)
poll-markets/pollPass           → persist_edge_evaluations         CHANGED (gate; same RPC edge)
apps/web/events/page.tsx (NEW)  → getEventsList → dash_events_list ADDED (WEB-1/2/3)
apps/web/layout.tsx             → NAV ['/events']                  ADDED (WEB-4)
apps/web/calibration/page.tsx   → (derived sources)               CHANGED (drop SOURCES const; WEB-5)
apps/web/events/[slug]/page.tsx → DistributionOverlay.modelPending CHANGED (new prop; WEB-6)
apps/web/city/[slug]/page.tsx   → DistributionOverlay.modelPending ADDED (follow-on; WEB-6)
health-monitor/handler.ts       → clear_system_halt (OPTIONAL)     ADDED (Phase-3; C3)
operator CLI                    → simulate-historical-edge         ADDED (ops wiring; DF-5)
backfill-market-history (ops)   → bucket_probabilities consensus   ADDED (prerequisite; DF-5)
```

No edge into the bet/fill path (execute-bet, bankroll, LiveExecutor) is added or changed. The `verified`/`betting_enabled` → bettable → bet edges are **untouched**.

---

## 11. Risk Register

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| **R-A1** | **The capture `stations:0` mechanism is UNPROVEN.** `list_active_stations()` returns 45 via the exact supabase-js wire shape (live curl), as service_role/anon/postgres, with fresh cities and a bit-identical deployed bundle — while `list_enabled_models` in the same `waitUntil` closure returns 2. The single unprobed suspect is an isolate-local difference (cold-start race on the first table-returning RPC, or a per-isolate env/URL/role edge). | **Highest** (gating Phase 2) | C1 (loud retryable `failed`) + C2 (log raw null-vs-`[]` + `{stations,models}` cardinality). Deploy both, let ONE cron slot fire, read edge logs for the `'capture inputs'` line + the `db.ts` empty-discriminator → pins it deterministically. Do NOT ship a speculative fix or a retry-loop (a no-arg VOLATILE SETOF returning `[]` is not a transient I could reproduce). |
| **R-A2** | **Partial `model_stats` coverage (~10/45 ICAOs, ~26/100 buildable events).** First house builds use `cfg.priorSigmaByLead` + equal weights for the other ~74 events — valid but uncalibrated. | Medium | By-design degradation, not a bug (§14 "coverage begins next cycle"). Surface uncalibrated-but-valid distributions clearly LABELLED (the `/events` model? chip + the model-pending caption). The daily source-collection / calibration cron densifies over time. |
| **R-A3** | **Info-time-matched scoring broken by a careless build.** A LIVE build from backfill (`p_allow_backfill=true`) on a resolved event would peek (recent `captured_at`); a `backfill-market-history` that stamps `made_at=now()` makes every backtest pair a peek. | High | DF-2 restricted to `target_date >= today` (or offline only); DF-5 backtest is the ONLY honest path to scored history; the prerequisite MUST stamp historical `made_at` — assert + spot-check. ADR-16 cutoffs are matched by construction for the de-gated build (HD-1). |
| **R-A4** | **Pool-safe idempotency on the widened cadence.** Persisting every tick must not race or duplicate. | Low | `poll-markets` is serialized by the `claim_poll_lease` CAS lease on `job_locks` (`0018:7-22`, expiry-based, NOT a session advisory lock — verified) → one isolate writes per tick. `persist_edge_evaluations` `on conflict … do nothing` → exactly 1 row/(event,bucket,hour). **X-3b:** "every tick" is reliable, NOT denser — do not mistake idempotency for densification. |
| **R-A5** | **Silent-break dashboard readers.** A new `house_gaussian` source value or the new `modelPending` prop could break an un-enumerated reader. | Low | Every reader of `bucket_probabilities` house rows (§7.1) and every `DistributionOverlay` call site (events + city pages) enumerated by whole-repo grep — all coalesce/filter by source; the new prop is optional. No unguarded typed-destructure on a new source value. `dash_events_list` has zero existing readers. |
| **R-A6** | **Dead-man halt does NOT auto-clear** (corrects DATA-LAYER-REVIEW.md:88). After C1/C2, health-monitor stops re-applying but the existing `halt:global` row persists → recommendation path stays dark indefinitely if the operator expects auto-clear. | Medium | Phase-2 manual `operator_resume('halt:global')` (zero code, the sole DELETE path, `0021:77`). Optional Phase-3 `clear_system_halt` must distinguish system vs operator halts (`config_audit.actor`) and only clear when freshness is CURRENTLY below threshold (info-time-matched), or it silently undoes a deliberate operator halt. |
| **R-A7** | **Cross-area sequencing.** HD-1 (Phase 3) + capture fix (Phase 2) BOTH required for the first house row; the edge audit (EDGE-1/2) produces zero rows until house exists. | Medium | State the ordering explicitly (§12 critical path). Phase 2a is the gating unknown. Land the audit write-path now (dormant); it lights up automatically when `house_gaussian` appears. |
| **R-A8** | **Index/read scale after `house_gaussian` doubles `bucket_probabilities`.** | Low | The latest-per-source read is index-backed by `bucket_probabilities_event_source_time_idx (event_id, source, made_at desc)` — **verified to exist** (`0005:27-28`; corrects spec-6 X-IDX). Watch only at multi-month retention; no new index needed now. |
| **R-A9** | **Adversarial re-coupling.** A future "cleanup" could re-add `verified` to the build/audit or move the audit back behind `bettable`, re-zeroing analytics. | Medium | HD-2 docstrings + the inline `0028` comment record intent; EDGE-3 invariant + a regression test (unverified-open-event-with-champion → edge_evaluations row with model-only reasons) lock it. |
| **R-SEC** | Investigation surfaced a live `wuApiKey` value into the transcript (archived to `_Logs/`). | — | Treat as compromised and **rotate it**. (Not a code change.) |

---

## 12. Implementation Roadmap

Phases match DATA-LAYER-REVIEW. **Critical path: Phase 2a (the capture defect) is the gating unknown** — without fresh non-backfill forecasts nothing produces a model probability. Phase 1 (surfacing) runs **in parallel** and is the fastest visible win.

### Phase 0 — Operational unblock (today, no code) — S
- **Goal/shippable:** confirm the chain can light up; necessary, not sufficient.
- **Modules:** none (admin actions). `operator_verify_station` for target cities OR `update city_stations set verified=true where valid_to is null` (analytics interim); confirm `halt:global` state.
- **DoD:** `cs_verified > 0`; operator understands this alone produces NO `house_gaussian` (no non-backfill forecasts) — Phase 2 is the real unblock. ADR-18 makes the verify step unnecessary permanently.

### Phase 1 — Surface existing data (parallel with Phase 2) — S/M
- **Goal/shippable:** the operator can finally SEE real collected data and validate the DBs populate.
- **Modules:** WEB-1 (`dash_events_list`, `0029`), WEB-2 (`getEventsList`), WEB-3 (`/events` page), WEB-4 (nav), WEB-5 (`/calibration` data-driven), WEB-6 (`/events/[slug]` model-pending) + city follow-on; EDGE-1/2/3 write-path (lands dormant, lights up post-Phase-2/3).
- **Dependencies:** none (reads existing data). EDGE-1/2 emit rows only once house exists.
- **DoD:** `/events` lists 119 events with collection-health + model? chip (all "pending" today); `/calibration` shows the market_consensus reliability diagram (45 rows); `/events/[slug]` shows market bars + explicit "model pending"; nav reaches `/events`; new `loaders.test.ts` case + `/events` Playwright smoke green (flips §15 "8 pages render with real data").

### Phase 2 — Fix live forecast capture (the real pipeline bug) — M/L  **[CRITICAL PATH, gating unknown = 2a]**
- **Goal/shippable:** fresh non-backfill forecasts → dead-man clears → `build-distributions` writes `house_gaussian` → the model probability exists.
- **Modules:** **2a** C1 (empty-station guard → retryable failed) + C2 (raw null-vs-`[]` instrument) + `JobInputError` (core); **2b** confirm `build-distributions` writes house once non-backfill rows land; C3 clear `halt:global` (manual `operator_resume`).
- **Dependencies:** ADR-19 (instrument-before-fix). 2b depends on 2a landing fresh rows AND HD-1 (Phase 3) — both required for the first house row.
- **DoD:** one hosted cron fire produces either a real capture (`stations:45, rowsUpserted>0`) or a loud `failed` + the logged cardinality/discriminator pinning the mechanism; `bucket_probabilities` gains `house_gaussian` after HD-1 also lands; `halt:global` cleared and stays clear.

### Phase 3 — Decouple analytics from the trading gate + densify the edge audit — M
- **Goal/shippable:** the model-vs-Polymarket edge computes for every open event regardless of betting authorization and accumulates as a time-series.
- **Modules:** HD-1/DF-1 (`list_buildable_events` drop verified, `0028`), HD-2 docstrings, EDGE-1/2/3 activate (champion now exists), DF-5 (scored history via `simulate-historical-edge` + `backfill-market-history` prerequisite); OPTIONAL DF-2/DF-3 (`p_allow_backfill`), C3 Phase-3 `clear_system_halt` (`0030`).
- **Dependencies:** Phase 2 (house must exist for the audit to emit rows; for DF-5, the consensus backfill prerequisite).
- **DoD:** `edge_evaluations > 0` accumulating per open event; `/events` model? chips flip to "built"; `/events/[slug]` EdgeChart renders with green drift check; ADR-18 signed off and recorded; optionally `calibration_scores(window_tag='backtest')` populated (info-honest, isolated from the go-live gate).

**Parallelism:** Phase 1 ∥ Phase 2 (independent). Phase 3 depends on Phase 2. Phase 0 is a same-day prerequisite confidence check (superseded by ADR-18).

---

## 13. Build Verification Checklist

Each item traces to a §6/§7/§8/§9 definition.

**Capture (§6.A, §7.5, §9.1/9.3)**
- [ ] `JobInputError` exported from `packages/core`; runJob formats `e.name: e.message` (C1 → §6.A).
- [ ] `snapshotForecasts` logs `'capture inputs' {stations, models}` then throws `JobInputError` when `stations.length===0` (C1; `handler.ts:40` → §6.A). Healthy run (45 stations) unaffected.
- [ ] `snapshotEnsembles` has the identical guard before the models fetch (C1; `handler.ts:28-31`).
- [ ] Empty-station run records `job_runs.status='failed'` (retryable via `claim_job_run` taken_over) + Slack JOB_FAIL — NOT `status:ok` (C1 → §7.5).
- [ ] `db.ts` rpc wrapper logs `{rpc, empty:true, dataWasNull}` on the fabricated-empty branch; mapping at `:40` otherwise unchanged; throw still only on PostgREST error (C2 → §6.A). Web `port.ts` twin untouched.
- [ ] One hosted cron fire read: `'capture inputs'` cardinality + the null-vs-`[]` discriminator captured (ADR-19 → R-A1).
- [ ] `halt:global` cleared via `operator_resume('halt:global')` after fresh forecasts confirmed; confirmed it does NOT re-apply (C3 → §6.A). (Optional) `clear_system_halt` only deletes `actor='system'` halts (`0030` → §7.3).

**House build (§6.B, §7.1, §9.1)**
- [ ] `0028_analytics_decouple.sql` `list_buildable_events()` drops `and cs.verified=true`; whole-repo grep confirms `build-distributions/handler.ts:6` is the sole caller (HD-1 → §7.1). Live: 0 → 100 events / 44 ICAOs.
- [ ] `build-distributions/handler.ts` has NO own verified check (verified) — only the RPC body changed (HD-2 → §6.B).
- [ ] `get_build_inputs` backfill exclusion (`0016:40,56`) UNCHANGED; (optional) `p_allow_backfill` defaults false and keeps the live path bit-identical (HD-3/DF-2 → §8).
- [ ] `buildDistributionForEvent` (optional) forwards `opts.allowBackfill`; three callers compile unchanged (DF-3 → §6.B).
- [ ] After Phase 2 + HD-1: `bucket_probabilities` gains `house_gaussian` for all 44 ICAOs (prior σ where no `model_stats`) (§9.1).

**Edge audit (§6.C, §7.4, §9.1)**
- [ ] `auditEdgesForOpenEvents` computes `computeBucketEdges` (NO `applyLiquidityFilters`) for all open events with a fresh champion; book reuse only (no new fetches); merges into `edgeRowsByEvent` without double-insert (EDGE-1 → §6.C).
- [ ] Step (8) gate is `if (edgeRowsByEvent.size>0)`; `getUTCMinutes()<5` removed; `captured_hour` stays hour-truncated → 1 row/(event,bucket,hour) (EDGE-2 → §7.4). `persist_edge_evaluations` unchanged.
- [ ] `bettable` (`handler.ts:302-305`) still gates ONLY the bet path; regression test: unverified/betting-disabled open event WITH champion+book → `edge_evaluations` row with model-only reasons, NO `station_unverified` (EDGE-3 → §6.C).
- [ ] `poll-markets.test.ts`: bettable fixture still 11 rows; tick-2 `evaluationsPersisted:0` now validates IDEMPOTENCY; ADD a minute-30 tick asserting N>0; ADD a non-bettable-open-event-with-champion fixture asserting rows appear.
- [ ] `ui-data.test.ts` no-drift recompute stays green (both sides `computeBucketEdges`).

**Dashboard (§6.D, §7.2, §9.1)**
- [ ] `0029_dashboard_events_list.sql` `dash_events_list(p_champion)`; `operator_guard()` is the first statement; ERR_FORBIDDEN for non-operator (WEB-1 → §7.2). Live counts match `{119,116,114,0,116}`.
- [ ] `getEventsList` + `EventsListView`/`EventListRow` exported; numeric fields `unknown`; default `events=[]` on null RPC (WEB-2 → §6.D). New `loaders.test.ts` case.
- [ ] `/events/page.tsx` renders the collection-health table + roll-up + model? chip; rows link to `/events/[slug]` and `/city/[slug]`; no bet/edge column; no route collision with `[slug]` (WEB-3 → §6.D). Playwright smoke green.
- [ ] NAV includes `['/events','events']` (WEB-4 → §6.D).
- [ ] `/calibration` derives `sources` from `v.scores`; `PROMOTABLE` restricts promote buttons to `house_*`; market_consensus reliability diagram renders (45 rows) (WEB-5 → §6.D).
- [ ] `/events/[slug]` + `DistributionOverlay` show explicit "model pending" when `houseDist===null && consensusDist!==null`; both-null state preserved; `recomputeEdgeRows` null short-circuit untouched (WEB-6 → §6.D). City page follow-on passes `modelPending`.

**Scoring (§6.E, §7, §9.2)**
- [ ] `simulate-historical-edge --source house_gaussian` writes `calibration_scores(window_tag='backtest')`; `go_live_gate_inputs` reads only `60d` (isolated) (DF-5 → §9.2).
- [ ] `backfill-market-history` stamps synthesized `market_consensus.made_at` at HISTORICAL pre-cutoff instants (NOT `now()`) — asserted + spot-checked (DF-5 → §9.4 / R-A3).

**Architecture alignment (§3)**
- [ ] ADR-18 recorded (verified gates bet path only; house+edge compute for every open ladder-ok event); operator signed off.
- [ ] ADR-19 recorded (capture defect = unproven runtime RPC-resolution; instrument before fix).
- [ ] §6.16 ARCHITECTURE.md:1142/1162 prose amended ("open, ungraded, ladder-ok event"; note verified now gates only the candidate/bet path).
- [ ] §15 "Dashboard: 7 pages" updated to 8 pages incl. `/events`.
- [ ] Index correction (§7.6) recorded: `bucket_probabilities_event_source_time_idx` exists (`0005:27-28`) — no new index claimed unverified.

---

### Cross-reference integrity note
Every §6 contract's **Called by** has a matching **Calls** on the other side (e.g. `pollPass → auditEdgesForOpenEvents → computeBucketEdges`; `EventsIndexPage → getEventsList → dash_events_list → operator_guard`; `build-distributions/handler.ts → list_buildable_events`). The analytics audit writes ONLY to `edge_evaluations` (no FK to `bets`, no path to `bankroll`) — the live-trading boundary is preserved by construction.
