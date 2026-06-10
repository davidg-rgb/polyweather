# Weather Edge — Architecture Blueprint

> Generated from: `REQUIREMENTS.md` (weather-edge-betting-spec.md v2) + three live-API research reports (`research/REPORT-*.md`, 2026-06-10)
> Date: 2026-06-10
> Status: DRAFT — Pending Review
> Operator decisions locked in: **full system in paper mode** (live executor built but dormant) · **Supabase + Vercel** hosting · **Slack** alerts · **$1,000 notional** bankroll

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Requirements Analysis](#2-requirements-analysis)
3. [Architecture Decision Records](#3-architecture-decision-records)
4. [Tech Stack](#4-tech-stack)
5. [Project Structure](#5-project-structure)
6. [Module & Function Definitions](#6-module--function-definitions)
7. [Data Models](#7-data-models)
8. [Interface Contracts](#8-interface-contracts)
9. [Data Flow Diagrams](#9-data-flow-diagrams)
10. [Dependency Map](#10-dependency-map)
11. [Cross-Cutting Concerns](#11-cross-cutting-concerns)
12. [Extensibility Guide](#12-extensibility-guide)
13. [Risk Register](#13-risk-register)
14. [Implementation Roadmap](#14-implementation-roadmap)
15. [Build Verification Checklist](#15-build-verification-checklist)

---

## 1. Executive Summary

Weather Edge is a probabilistic temperature-forecasting and market-analysis system targeting Polymarket's daily "Highest temperature in {City} on {Date}" markets. It snapshots multi-model weather forecasts for every city Polymarket lists (49 as of 2026-06-10, discovered dynamically), validates them against the exact data source that resolves the markets (Wunderground station daily highs), calibrates per-station/per-model/per-lead bias and error, converts calibrated ensembles into bucket probability distributions, compares those distributions against live market prices, and produces fractional-Kelly-sized **paper** bet recommendations delivered via Slack and a dashboard. A live-trading executor is built into the codebase but ships dormant behind a calibration gate (≥60 days out-of-sample, house Brier beating market-consensus Brier) plus a manual go-live switch.

The research phase (see `research/`) live-verified every external integration and corrected four load-bearing assumptions in the source spec:

1. **Fees**: weather markets charge a dynamic taker-only fee `shares × 0.05 × p × (1−p)` (≈1.25% of notional at 50¢, <0.5% at tails) with 0% maker fees + 25% maker rebates — not a flat 2%. The edge threshold is therefore price-dependent and the system prefers maker-style entries.
2. **Universe**: ≈50 cities are live (51 at review time, not 8), discovered via Gamma tag `104596`; the roster rotates without announcement; resolution stations change mid-cycle (Paris moved CDG→Le Bourget after the April 2026 sensor-tampering incident). Cities and stations are data, not constants.
3. **Truth source**: the resolving number is reproducible programmatically as `max(observations[].temp)` from `api.weather.com` v1 hourly observations over the station's local day — verified to match the Wunderground history page exactly, while the v3 daily-summary endpoint diverges (87°F vs 89°F same day). The truth pipeline implements precisely the v1-hourly-max semantics, cross-checked by independent METAR and IEM sources.
4. **Calibration backfill**: Open-Meteo's Previous Runs API provides lead-time forecasts (1–7 days) back to 2021–2024 per model, so the system reaches statistically useful calibration in days, not months. The 60-day live-gate still applies to forward out-of-sample performance.

Runtime architecture: a TypeScript monorepo. Supabase hosts Postgres (system of record) and all scheduled jobs (pg_cron → pg_net → Edge Functions; Vercel Hobby crons cannot run sub-daily). A Next.js dashboard on Vercel renders recommendations, calibration health, and P&L, and hosts the approval/admin API. Pure domain logic (bucket parsing, fee math, joint Kelly, EMOS, distributions) lives in a runtime-agnostic `packages/core` consumed by both Deno Edge Functions and the Node web app, and is the unit-test surface. Heavy one-off work (multi-year backfills) runs as local scripts against the same database.

The honest framing from the spec stands: this is statistical gambling against sharp competition (named bots with six-figure P&L operate in these markets). The system's job is to make the calibration evidence undeniable before a dollar is staked, and to make every recommendation auditable down to the stored numbers that produced it.

---

## 2. Requirements Analysis

### 2.1 Core Features

**Data ingestion**

- **F-001 Market discovery.** Enumerate all active Polymarket highest-temperature events via Gamma `events?tag_id=104596&active=true&closed=false` (paginated, limit 100), filter zombies (`endDate >= today`), upsert cities/events/buckets, and tail-call the distribution builder for newly created events (ADR-16 row-existence guarantee). Runs at 02:10, 04:10, 05:10, 11:10, 17:10 UTC (live-verified creation waves: Americas ~02:0x UTC at T+1, APAC ~04:0x at T+2, EMEA ~05:0x at T+2).
- **F-002 Station resolution.** Parse each market's `resolutionSource` URL to extract the resolving ICAO + country code; maintain a temporal `city_stations` mapping; detect mid-cycle station changes, alert, and suspend betting for that city until manually re-verified.
- **F-003 Forecast snapshots.** Twice daily (10:15, 22:15 UTC — after the 00Z/12Z run sets complete), capture `temperature_2m_max` for all active stations from 8 working Open-Meteo models + `best_match` in one multi-model call per station; store per (station, model, target_date, lead, slot). Note: markets exist only at lead 0–2 (live-verified creation ~T+2), so leads 3–7 feed calibration and the dashboard, never betting.
- **F-004 Ensemble snapshots.** Twice daily, capture per-member daily-max from ECMWF ENS (50+1) and GEFS (30+1) via the Ensemble API; store member arrays.
- **F-005 Forecast gap-fill.** Detect missing snapshot rows (job failures, new stations) and recover up to 7 days of leads via the Previous Runs API.
- **F-006 Actuals — canonical.** After each station's local day ends, fetch `api.weather.com` v1 `observations/historical.json` (runtime-extracted key), compute the WU daily max in the market's native unit, store with finalization status ("first datapoint of the following date published").
- **F-007 Actuals — independent.** Cross-check every finalized daily max against aviationweather.gov METAR-derived max and IEM `daily.json`; store divergences; alert when |Δ| ≥ 1 native degree.
- **F-008 Actuals — ERA5T sanity.** Daily pull of ERA5T `temperature_2m_max` via `archiveUrl`/`parseEra5Daily` (§6.10) as a gridded sanity reference (never used for grading).
- **F-009 Intraday running max.** Every 15 minutes during a station's local day, update the observed running max from METARs (tenths °C → WU-rounding replica) for nowcast distributions and the dashboard.
- **F-010 Historical backfill — forecasts.** Resumable local script: Previous Runs API leads 1–7 for all stations × 8 models back to each model's archive start (2021–2024); Historical Forecast API day-0 series as pseudo-truth baseline.
- **F-011 Historical backfill — actuals.** Resumable local script: WU v1 daily maxes (with IEM fallback) covering the backfilled forecast range.
- **F-012 Historical backfill — market prices.** Best-effort local script: closed Gamma events (tag 104596) + CLOB `prices-history` per token → historical market-consensus distributions and resolved winners, enabling house-vs-market Brier measurement before any live days accumulate.

**Calibration & distributions**

- **F-013 Per-model calibration.** Maintain decaying-average bias (α=0.15) and rolling residual σ (30-day window, min n=8) per (station, model, lead); inverse-MSE model weights per (station, lead).
- **F-014 House distribution.** Gaussian method v1: bias-corrected weighted ensemble mean + calibrated σ → probabilities over the exact market bucket ladder (native unit, ±0.5° continuity correction, open tails).
- **F-015 Ensemble-empirical distribution (challenger).** Dressed ensemble members (member values + residual noise) → empirical bucket probabilities; runs alongside Gaussian as a challenger source.
- **F-016 Market-consensus distribution.** Normalized mid-price implied distribution per event snapshot, stored as `source='market_consensus'` — the benchmark every house source must beat, compared only on time-matched rows (ADR-16).
- **F-017 Nowcast constraint.** On the target day, truncate house distributions at the observed running max (Tmax ≥ running max is a hard physical constraint) and renormalize; flagged as `nowcast=true`.
- **F-018 Scoring.** Brier score, ECE, reliability bins, and sharpness per (city, lead, source) over rolling windows; persisted after every resolution. Scored on **time-matched rows only**: per (event, source, lead ∈ {0,1}), the last distribution made at or before that lead's information cutoff (ADR-16) — so house and market are compared on equal information, and only on (event, lead) pairs where both sources have a scored row; nowcast-constrained rows are scored separately under window tag `nowcast`, never in the gate.
- **F-019 Champion/challenger.** Promotion of a distribution source to "betting champion" requires ≥60 days out-of-sample, pooled per-event time-matched Brier difference vs `market_consensus` significant at p < 0.05 (paired bootstrap, ADR-16) AND a ≥5% better point estimate, and manual approval in the admin UI.

**Market data & edge engine**

- **F-020 Price polling.** Every 5 minutes, refresh all active events via the same Gamma tag query (bestBid/bestAsk/spread per bucket included); store delta-deduped snapshots.
- **F-021 Order-book depth.** For buckets passing the edge pre-filter, fetch the CLOB book and compute the executable ask for the intended size (walking the book), not just top-of-book.
- **F-022 Edge computation.** Per bucket: `edge = q_house − executable_ask`; filters: event volume ≥ $2k (config `minEventVolumeUsd` — deliberately low: live data shows $10k would veto 62% of events including NYC at lead-1; per-bucket book depth is the real liquidity check), spread ≤ `maxSpread` (5¢, enforced in `applyLiquidityFilters`), book depth ≥ intended stake (executableAsk walk), time-to-resolution > 2h, station verified, no active halt.
- **F-023 Joint Kelly sizing.** Per negRisk event, size simultaneously across all qualifying buckets with the state-price greedy algorithm (sort by q/p, threshold c, stakes (q−c·p)₊), scaled by k=0.25, then capped (per-trade 2%, per-event 5%, per-cluster 8%, daily 15% of bankroll).
- **F-024 Recommendations.** Qualifying sized bets are written to `bets` (`status='recommended'`) idempotently, pushed to Slack with edge math, and expire automatically if edge decays before approval.

**Bets lifecycle (paper) & risk**

- **F-025 Paper approval & fill.** Operator approves via dashboard/Slack link; `PaperExecutor` re-fetches the live book at approval and fills at the WORSE of stored vs live walked ask, + 1¢ slippage + taker fee; recommendations whose stored book is older than `paperBookMaxAgeMin` (5 min) without a fresh fetch are rejected (422). Deliberately pessimistic vs the maker-first live posture, so live execution can only beat paper. Risk caps are re-evaluated against current open exposure at fill time, not just at recommendation time.
- **F-026 Grading.** On WU finalization, determine the winning bucket from the actual; grade bets; compute P&L net of modeled fees; update the paper bankroll ledger; verify our winner equals Polymarket's resolved winner (mismatch = CRITICAL alert); emit a per-event RESOLUTION Slack INFO (deduped). Hit-rate-by-edge-decile is derived at read time from resolved bets via the `edge_decile_stats` view (§7.15a) feeding the fidelity report (§11.4), digest, and ledger.
- **F-027 Risk circuit breakers.** Auto-halt scopes: 8 consecutive losses per (city, lead); −5% daily P&L; 25% peak-to-trough drawdown; rolling 30-day Brier > 0.30 per city; data-staleness dead-man (no fresh forecasts/prices). Halts require manual resume with audit.
- **F-028 Exposure accounting.** Live view of open paper exposure by event, city, cluster, and day vs caps.

**Notifications & dashboard**

- **F-029 Slack alerts.** Incoming-webhook notifier with severity routing and dedup: BET_REC, BET_EXPIRED, RESOLUTION, JOB_FAIL, JOB_STALE, DATA_DIVERGENCE, STATION_CHANGE, MODEL_DEGRADED, WU_KEY, PARSE_FAIL, POSITION_DRIFT, CALIB_DRIFT, BREAKER, DIGEST. Delivery is marked sent only on HTTP 2xx; unsent alerts are re-sent by health-monitor's sweep (§6.19); an external uptime pinger on `/api/health` is the out-of-band backstop for "Slack itself is down" (§11.5).
- **F-030 Dashboard.** Next.js pages: `/` (today: bankroll, open recs, exposure, P&L spark), `/events/[slug]` (edge view: house vs market distribution overlay, book, Kelly math, audit trail), `/city/[slug]` (today's open market with our distribution overlay, per-station calibration heatmap, bet history, station history), `/calibration` (Brier trends, reliability diagrams, ECE, champion/challenger), `/bets` (ledger + filters), `/system` (job health, API status, data gaps), `/admin` (halts, config with audit, station verification, source promotion, manual job triggers).
- **F-031 Daily digest.** 07:00 UTC Slack summary: bankroll, yesterday's resolutions & P&L, rolling Brier house-vs-market, open recommendations, job health.

**Trading (dormant) & ops**

- **F-032 Live executor (dormant).** `LiveExecutor` implementing the same `TradeExecutor` interface via `@polymarket/clob-client` (L1 derive → L2 HMAC, GTC/GTD limit orders, `negRisk: true`, per-market tick/min-size respected); enabled only when `goLiveGate()` passes (env key present + config flag + calibration gate query + geoblock re-check) — never enabled by default.
- **F-033 Reconciliation (live phase).** Implemented as the live-mode branch of the grade-bets sweep (§6.19): nightly compare of `bets` vs `data-api.polymarket.com/positions` for the operator wallet; discrepancies alert CRITICAL (POSITION_DRIFT). No-op while `tradingMode='paper'`.
- **F-034 Job observability.** Every job run recorded (`job_runs`) with idempotency key, duration, counts, errors; health-monitor compares actual vs expected schedule matrix, alerts on staleness, and **reaps stuck runs** (status `running` past the wall-clock limit → `failed`, alert, period becomes retryable).
- **F-035 Manual bet entry.** `/admin` can record a manually-placed bet (paper or live) through the same `bets` schema and fill path (spec §12), so the ledger is complete even when the operator acts outside the engine.
- **F-036 Withdrawal discipline (live phase).** `bankroll_ledger` supports `withdrawal` entries; the first-of-month digest reminds the operator to sweep profits off-platform (spec §10); RUNBOOK documents the procedure.
- **F-037 Database backup.** Weekly `scripts/backup-db.ts` pg_dump to a local target (RUNBOOK schedule) — the bets/ledger audit trail is the system's evidentiary core and the free tier has no PITR.
- **F-038 Edge-evaluation audit trail.** Hourly persistence of the full per-bucket edge evaluation (q, exec ask, edge, pass, reasons) for every open event — so "why didn't we bet yesterday's obvious winner" is answerable from stored data, not reconstruction.

### 2.2 User Roles & Journeys

Single operator (David). No multi-tenancy; Supabase Auth with one allow-listed email; RLS denies everything else.

- **J-1 Morning review (daily, ~5 min).** Slack digest → dashboard `/` → scan open recommendations → approve/skip → check `/system` for failures. (Flow 9.10.)
- **J-2 Recommendation approval (event-driven).** Slack BET_REC → `/events/[slug]` → inspect distribution overlay + Kelly math → Approve (paper fill) or Skip with reason.
- **J-3 Calibration audit (weekly).** `/calibration` → Brier house vs market per city/lead → reliability diagrams → soft-disable persistently bad cities → review challenger performance.
- **J-4 Incident response.** Slack JOB_FAIL/DATA_DIVERGENCE/STATION_CHANGE → `/system` or `/admin` → manual re-trigger, station re-verify, or halt.
- **J-5 Go-live (one-time, months away).** `docs/GO-LIVE-CHECKLIST.md`: 60-day gate report → wallet setup → env secrets → geoblock re-check → flip config → Phase A manual approval at $20 hard cap.

### 2.3 Constraints

| Constraint | Value | Source |
|---|---|---|
| Scheduler granularity | Vercel Hobby crons are daily-only → all sub-daily jobs run on Supabase pg_cron | research §7 (strategy report) |
| Supabase Edge Function limits (free) | 150s wall / 2s CPU / 256MB; 500k invocations/mo; pg_net ~5s trigger timeout → fire-and-forget + background completion | research §7 |
| Supabase DB size | free tier 500 MB → delta-dedupe, retention rules on ALL high-volume tables (§7.5, §7.11, §7.12), raw books truncated to top 3 levels; **Supabase Pro ($25/mo) is budgeted from P4 (backfill) onward** — honest math in R-4 says backfill + steady-state ingest exceed 500 MB | §7 retention + R-4 |
| Open-Meteo free tier | 600/min, 5k/hr, 10k/day, 300k/mo; >10 vars or >2 weeks per call counts fractionally; non-commercial | weather report §6 |
| Open-Meteo plan gating | Previous Runs / Historical / Ensemble / ERA5 need Professional €99/mo for commercial use; free tier acceptable while non-commercial/prototyping — revisit at go-live | weather report §6 |
| Polymarket rate limits | Gamma /events 500 req/10s; CLOB /book 1500 req/10s — generous vs our needs | polymarket report §5 |
| Market sizes | `orderMinSize` 5 shares; tick 0.01 or 0.001 per bucket (read per market) | polymarket report §2 |
| Fees | taker `0.05·p·(1−p)`/share; maker 0 + 25% rebate; re-read `feeSchedule` per market | polymarket report §5 |
| Bankroll | $1,000 notional paper; per-trade cap 2% = $20 | operator decision |
| Timezones | 49 cities across all offsets incl. DST; every local-day computation goes through one tested module | §6.1 |
| Legal | Sweden currently unblocked; MiCA transition ends 2026-07-01 — go-live gate re-checks geoblock list; tax tracking (every close = K4 disposal) | strategy report §4 |

### 2.4 Integrations

| System | Base URL | Auth | Used for |
|---|---|---|---|
| Polymarket Gamma | `https://gamma-api.polymarket.com` | none | discovery, metadata, prices (bestBid/bestAsk per bucket) |
| Polymarket CLOB (data) | `https://clob.polymarket.com` | none | order books, midpoints, prices-history |
| Polymarket CLOB (trading) | same | L1 wallet sig → L2 HMAC | dormant executor |
| Polymarket Data API | `https://data-api.polymarket.com` | none | positions/trades (live-phase reconciliation) |
| Open-Meteo Forecast | `https://api.open-meteo.com/v1/forecast` | none (free) / `customer-` host + key (paid) | multi-model daily Tmax |
| Open-Meteo Previous Runs | `https://previous-runs-api.open-meteo.com/v1/forecast` | same | lead-time backfill + gap-fill |
| Open-Meteo Ensemble | `https://ensemble-api.open-meteo.com/v1/ensemble` | same | per-member daily Tmax |
| Open-Meteo Archive | `https://archive-api.open-meteo.com/v1/archive` | same | ERA5T sanity |
| Open-Meteo model meta | `https://api.open-meteo.com/data/{domain}/static/meta.json` | none, uncounted | run availability for health checks |
| api.weather.com v1 | `https://api.weather.com/v1/location/{ICAO}:9:{CC}/observations/historical.json` | embedded public key, extracted at runtime | canonical WU daily max |
| aviationweather.gov | `https://aviationweather.gov/api/data/metar` | none | METAR cross-check + running max |
| IEM | `https://mesonet.agron.iastate.edu/api/1/daily.json` | none | secondary daily max |
| Slack | incoming webhook URL | webhook secret | all alerts |
| Supabase | project URL | service role (jobs) / anon+RLS (web) | DB, auth, Edge Functions, pg_cron |
| Vercel | — | — | dashboard hosting |

### 2.5 Open Questions / Resolved Ambiguities

| # | Question | Resolution |
|---|---|---|
| A-1 | Build trading machinery now or later? | **Operator: full system, paper mode.** Executor module built, dormant behind `goLiveGate()`. |
| A-2 | Hosting? | **Operator: Supabase + Vercel.** pg_cron is the only scheduler; Vercel hosts dashboard only. |
| A-3 | Alert channel? | **Operator: Slack** (incoming webhook). Notifier is interface-based for future channels. |
| A-4 | Bankroll? | **Operator: $1,000 notional.** Stored in `config`, changeable with audit. |
| A-5 | Which cities? | All discovered cities are tracked for data; betting is per-city opt-in (`cities.betting_enabled`), default ON once station verified, auto-OFF on station change/breaker. |
| A-6 | Spec's 8-city table vs reality | Spec table is stale (London=EGLC not EGLL; Paris=LFPB). Station truth = parsed `resolutionSource` per market + airports dataset coordinates + manual verification flag. |
| A-7 | Spec's flat 2% fee / 8pp threshold | Replaced by price-dependent `minEdgeRequired(p)` (§6.4); default uncertainty margin 5pp + spread buffer + taker fee curve; maker-entry modeling deferred to live phase (paper assumes taker — pessimistic). |
| A-8 | Lowest-temperature markets (8 cities exist) | Out of scope v1; schema carries `market_events.kind` (`'highest'|'lowest'`) so adding them is a job-config change, not a migration. |
| A-9 | Kalshi cross-platform | Out of scope v1; `MarketVenue` seam documented in §12. |
| A-10 | Open-Meteo commercial licensing | Free tier during paper phase (personal, non-commercial research). Budget €99/mo Professional at go-live; revisit terms then. Risk register R-3. |
| A-11 | WU "truncation vs rounding" conflict in sources | WU's displayed integer (already rounded server-side in `temp`) is what resolves. We never re-derive it from tenths; paper phase logs tenths-METAR max alongside for empirical confirmation. |
| A-12 | Sub-daily forecast snapshots? | Two snapshots/day (00Z+12Z sets) for v1; intraday edge comes from the METAR nowcast constraint, not extra model pulls. 06/18Z snapshots are a config change (R-12). |
| A-13 | Spec §12 `/bets/[id]` detail page | Folded into `/events/[slug]` (full per-bet audit JSON rendered there); a separate bet route is a deliberate drop. |
| A-14 | Spec §5 "continuous edge monitor on open positions" | v1 policy = **hold-to-resolution** (ADR-17): filled positions are displayed with current champion q and trigger a WARN when q falls below ½ of entry q, but are never auto-exited. Selling before resolution is a live-phase enhancement (§12). |
| A-15 | Spec §3.1/§7 "season" σ clusters | v1 σ is rolling-window per (station, model, lead, slot); explicit season stratification ships later as a challenger source (R-10). |
| A-16 | Spec §6 `bets.ev_per_share` column | EV per share = q − p = the stored `edge` itself (spec §3.3); EV per $ staked = edge / exec_ask. Both live in the audit jsonb; no dedicated column. |

---

## 3. Architecture Decision Records

**ADR-01 — TypeScript monorepo (pnpm workspaces) with a pure domain core.**
Decision: one repo: `packages/core` (pure TS, zero IO, zero runtime deps beyond zod), `packages/db` (generated types + query helpers), `apps/web` (Next.js), `supabase/functions` (Deno Edge Functions importing core via relative path), `scripts/` (Node CLIs).
Alternatives: Python for the stats layer (rejected: EMOS v1 is closed-form algebra — normal CDF, decaying averages, weighted means — no scipy needed; one language halves the test/deploy surface); separate repos (rejected: shared types are the whole point).
Consequence: `packages/core` must stay Deno-compatible — no Node built-ins, no `process.env` (config injected), file-extension imports.

**ADR-02 — Supabase is the runtime; Vercel only renders.**
Decision: pg_cron (in-database scheduler) fires pg_net HTTP POSTs to Supabase Edge Functions; every scheduled behavior lives there. Vercel hosts the dashboard + operator API routes only.
Alternatives: Vercel crons (Hobby = daily granularity — disqualified for 5-min polling); GitHub Actions (documented multi-minute delays/dropped runs — disqualified as primary); a VPS (more control, but another box to manage; revisit if Edge limits bind).
Consequence: jobs must fit 150s wall / 2s CPU; the cron POST returns 202 immediately and completes work via `EdgeRuntime.waitUntil` (pg_net times out at ~5s and that's fine — fire-and-forget); `job_runs` is the source of truth for success, not the HTTP response.

**ADR-03 — Cities, stations, and buckets are data discovered from the market, never constants.**
Decision: discovery upserts cities from event slugs; the resolving station is parsed from each market's `resolutionSource` URL (terminal path segment = ICAO); station coordinates come from a seeded airports dataset (OurAirports export) with manual override; `city_stations` is temporal (valid_from/valid_to) and a station change auto-suspends betting for that city pending `/admin` re-verification.
Why: live-verified that stations differ from the spec's table and change mid-cycle (Paris CDG→LFPB, April 2026). polymarketweather.com: "coordinate mismatch is the single most common cause of unexpected losses."
Alternatives: hardcoded station map (the documented #1 way to lose money).

**ADR-04 — Native-unit bucket math; °C canonical for forecasts; WU integers never re-derived.**
Decision: forecasts stored in °C (Open-Meteo native, 0.1 precision). Buckets stored as native-unit integer ranges (`87°F or below` → high=87; `94-95°F` → 94..95; `19°C or higher` → low=19). Probability integration happens in the market's native unit: for °F cities, μ/σ are converted linearly (F = C×9/5+32) before bucketization. Observations store WU's integer in native unit (pulled with `units=e` for °F cities — WU rounds server-side) plus the METAR tenths-°C max for diagnostics.
Why: live-verified WU rounds tenths-°C to whole °C and whole °F independently (30.6°C → 31°C and 87°F); re-deriving °F from a stored °C integer produces off-by-one bucket assignments.

**ADR-05 — Truth hierarchy with divergence accounting.**
Decision: WU v1 hourly-obs max = grading truth. aviationweather METAR replica = independent check + intraday nowcast. IEM daily = second opinion. ERA5T = gridded sanity. All four stored; any |WU − METAR-replica| ≥ 1° or |WU − IEM| ≥ 2°F raises DATA_DIVERGENCE; grading additionally verifies our winner against Polymarket's own resolved `outcomePrices` and treats mismatch as CRITICAL (our truth model is wrong or a dispute happened).
Why: the v3 dailysummary endpoint demonstrably diverges from the resolving page; Kalshi-style CLI values run 1°F+ hot; silent truth drift is the failure mode that poisons everything downstream.

**ADR-06 — Distribution methods behind a registry; Gaussian first, ensemble-empirical challenger, market consensus always.**
Decision: `DistributionMethod` interface with implementations `house_gaussian` (v1 champion candidate), `house_ensemble` (dressed 80-member empirical, challenger), `market_consensus` (benchmark). All write to the same `bucket_probabilities` table tagged by `source`; scoring treats sources symmetrically; betting reads only the configured champion.
Why: §9 of the spec (no betting without calibration evidence) becomes enforceable when every method is scored identically; adding isotonic recalibration later = new registry entry, no schema change.

**ADR-07 — Price-dependent economics; maker-first posture deferred to live.**
Decision: `minEdgeRequired(p) = uncertainty_margin (0.05) + spread_buffer (half observed spread, min 0.01) + takerFeePerShare(p)/1` expressed in probability points; paper fills modeled as taker at executable ask + 1¢ + fee (pessimistic). The live executor will post GTC maker orders (0 fee, +rebates), so realized live costs should beat paper assumptions — the divergence is enumerated in §11.4 (paper-fidelity contract) rather than hidden.
Alternatives: flat 8pp threshold (spec v2) — rejected as miscalibrated at tails where the fee is <0.5%; modeling maker fills in paper (rejected v1: fill probability unknowable without order placement; pessimism is the safe direction).

**ADR-08 — Joint Kelly per negRisk event, then fraction, then caps.**
Decision: per event, run the state-price greedy algorithm over the PASSING buckets only (all filters plus q > p′, where p′ = execAsk + takerFee(execAsk) + slippage; p′ ≥ 1 — reachable on nowcast-certain buckets — is exclusion, never an error, W20): sort by q/p′; find threshold c; stakes (q − c·p′)₊ as bankroll fractions; scale by k=0.25; then apply caps in order: per-trade 2% → per-event 5% → cluster 8% → daily 15%; every cap application is recorded in the bet's audit JSON.
Policy note: restricting candidates to positive-edge buckets deliberately forgoes negative-edge hedge legs the unrestricted log-optimum can include — "never buy a negative-edge bucket, even as a hedge" is stated policy, conservative in direction (smaller Σf), and ALL optimality/property claims are scoped to this restricted candidate set.
Why: buckets are mutually exclusive; naive per-bucket Kelly over-allocates and ignores cross-hedging (research §6d, Whelan + arXiv 2603.13581).

**ADR-09 — Recommendations are idempotent, expiring, audit-complete, and race-free.**
Decision: a recommendation is keyed by (bucket, distribution row, price band) — re-polls refresh rather than duplicate; unapproved recommendations expire when edge < threshold/2 or at T−2h to resolution; every bet row stores the full input vector (q, ask, book hash, σ, μ, model weights version, config version) so any historical bet can be re-derived exactly. **Every bet status transition is a compare-and-set**: `UPDATE bets SET status=… WHERE id=… AND status='<expected>' RETURNING` — the approve-vs-expire race resolves to whichever lands first, the loser gets a clean 409, and no transition can clobber another.
Why: spec §15 — "if you cannot derive your stake from stored values, don't place the trade" — and the expiry job overlapping a human click is a certainty, not an edge case.

**ADR-10 — Executor behind one chokepoint, in its own Edge Function, with layered gating.**
Decision: single `TradeExecutor` interface; `PaperExecutor` (default) and `LiveExecutor`. **All execution — paper and live — runs inside a dedicated 12th Edge Function `execute-bet`** (§6.20a); the web approve route is a thin authenticated proxy to it (same server-side-secret pattern as trigger-job). `LiveExecutor` constructs only when: `POLY_PRIVATE_KEY` present in *that function's* secrets AND `config.tradingMode='live'` AND `goLiveGate()` passes (calibration significance gate, geoblock re-check, breaker state clear, ledger reconciled). **A live-mode gate failure is a hard 503 to the operator — never a silent downgrade to a paper fill.** The signing key never exists in Vercel env; no code path outside `packages/trading` imports `@polymarket/clob-client` or reads `POLY_PRIVATE_KEY`; the executors are consumed only by execute-bet, and the web app may import only `gate.ts` for the /admin readout (lint-enforced boundary, §8.3).
Why: privilege-boundary chokepoint pattern; "never trust N call-sites to repeat the order of checks" — and a web dyno is the wrong trust domain for a wallet key.

**ADR-11 — Slack via incoming webhook with severity routing, dedup, and at-least-once delivery.**
Decision: one webhook env var; notifier dedupes by (kind, entity, day) via `alerts_log` unique index; severities: INFO (digest, resolutions), ACTION (bet recs — includes deep link), WARN (divergence, expiry), CRITICAL (job failures, breaker, grading mismatch, station change). **A dedupe key is only consumed by a delivered alert**: rows are inserted `sent=false`, flipped on HTTP 2xx; health-monitor re-sends unsent rows — a transient Slack outage delays alerts, never destroys them. Slack remains a single channel by design; the out-of-band backstop is an external uptime pinger on `/api/health` (R-18).
Alternatives: Slack bot app with interactive buttons (richer approve-in-Slack flow; deferred — approval stays in the dashboard v1 to keep secrets/scopes minimal; seam documented in §12).

**ADR-12 — Idempotency as a system-wide default, with a reaper for stuck runs.**
Decision: every job invocation carries a period key (e.g. `snapshot-forecasts:2026-06-10T10Z`); `job_runs` unique on (job, period_key) makes re-fires no-ops — **409 only when the existing run is `ok`, or `running` and younger than the wall-clock limit**; health-monitor reaps `running` rows older than the limit to `failed` (alert), which makes the period retryable instead of permanently lost. Ingest writes via natural-key upserts; web mutations use compare-and-set conditional updates (ADR-09); ledger entries are unique per (bet, type); poll-markets serializes overlapping invocations with a **`job_locks` lease row claimed by CAS UPDATE with expiry = wall limit** (NOT a pg advisory lock — session-scoped locks are broken over PostgREST's connection pool and leak on isolate kill, C8); the multi-bet caps race in execution is serialized by `pg_advisory_xact_lock` INSIDE a single fill RPC (transaction-scoped locks in one RPC call are pool-safe, W17).
Why: pg_cron + pg_net + Edge retries guarantee at-least-once delivery, and a killed isolate mid-`waitUntil` must not wedge a period forever.

**ADR-13 — Single-user Supabase Auth + deny-by-default RLS.**
Decision: email-OTP auth restricted to one allow-listed address; all tables RLS-enabled with `authenticated AND email = config` read policies; writes only via service-role (Edge Functions) and the web server's narrowly-scoped server actions; anon role has zero grants.
Why: the dashboard will eventually display position data worth real money; public-by-accident is unacceptable.

**ADR-14 — Raw SQL migrations + generated types; no ORM.**
Decision: schema lives in `supabase/migrations/*.sql` (supabase CLI); `supabase gen types typescript` produces `packages/db/src/types.gen.ts`; data access via `supabase-js` v2 typed clients plus a thin query module per domain. Postgres does the heavy lifting (window functions for rolling stats, partial indexes, generated columns).
Alternatives: Drizzle/Prisma (rejected: pg_cron schedules, RLS policies, and partial indexes live in SQL anyway; one source of truth beats two). Secrets in SQL: pg_cron commands read `CRON_SECRET` from **Supabase Vault** (`vault.decrypted_secrets`) at fire time — the literal secret never appears in committed migrations or the `cron.job` table; the Vault entry is seeded manually per RUNBOOK.

**ADR-15 — Nowcast as a constraint, not a model.**
Decision: v1 target-day distributions apply `P(Tmax = b) = 0` for buckets entirely below the observed running max, renormalizing the remainder; a per-(station, local-hour) empirical "remaining lift" table (built from backfilled hourly data) sharpens the surviving mass. No attempt to out-model HRRR sharps intraday; the constraint alone removes the dumbest losses (buying buckets already physically eliminated).
Why: research shows final-12h is where volume concentrates and where the running max is decisive; truncation is unarguable physics, cheap, and testable.

**ADR-16 — Time-matched scoring cutoffs (the comparison that everything gates on).**
Decision: Brier comparisons between sources are valid only at equal information. Define `cutoff(event, lead) = localDayWindow(tz, target_date).startUtc − lead × 24h` (exact 24-hour steps back from the local midnight that starts the target day — NOT "local midnight of D−lead", which differs on the two DST-transition days a year; the 24h-step definition is what both sources are scored against, so it stays unbiased). **Scored leads are 0 and 1 only** (C7: every fixture shows events created DURING local D−2, i.e. after any lead-2 cutoff — lead-2 scored rows can never exist for either source). For every (event, source, lead), the **scored row** is the last `bucket_probabilities` row with `made_at ≤ cutoff` and `nowcast=false`; gradeEvent stamps it (appends to `scored_for_leads[]` — one row can legitimately be the cutoff row for both leads on a quiet market, W18) and writes its Brier; runCalibration aggregates only scored rows, and **gate/promotion statistics use only (event, lead) pairs where BOTH the house source and `market_consensus` have a scored row** — asymmetric availability must not tilt the comparison (C7).
Row existence is guaranteed by construction (C7) **for cities with at least one prior forecast-snapshot cycle**: discover-markets tail-calls the distribution builder for every newly created event (~02:15/04:15/05:15 UTC, always before the earliest cutoff — verified against fixture timelines for NYC, LA, Wellington [lead-1 cutoff 12:00 UTC under NZST], Seoul), and the 10:50/22:50 builds refresh thereafter. A brand-new city's first event has no forecasts to build from — its (event, lead) pairs simply drop out symmetrically under the both-sources rule; coverage begins with the next snapshot cycle.
The market-history backfill synthesizes consensus rows at these same cutoffs from `prices-history` timestamps, and `simulateHistoricalEdge` uses identical cutoffs.
Why (adversarial finding C2): consensus written at 23:50 local has Brier ≈ 0 — pooled un-matched comparison is unwinnable for the house and the go-live gate would be structurally meaningless in either direction.
Alternatives: score every row (rejected — apples to oranges); score at market-close (rejected — post-max information); scoring lead 2 (rejected — rows physically cannot exist before event creation).

**ADR-17 — Open positions are held to resolution (v1).**
Decision: once filled, a position rides to resolution. The engine never sells; poll-markets displays current champion q on open positions and emits a WARN when q < ½ entry q (information, not action). Selling/exit logic (and maker resting orders) are live-phase enhancements behind the executor seam (§12).
Why: paper-phase exit modeling doubles the fidelity problem (§11.4) for marginal learning value; the spec's "edge monitor on open positions" is satisfied by monitoring + alerting, with the policy stated instead of implied.

---

## 4. Tech Stack

| Layer | Choice | Version | Why |
|---|---|---|---|
| Language | TypeScript (strict) | 5.x | one language across core/jobs/web/scripts |
| Package manager | pnpm workspaces | 9.x | monorepo, content-addressed store |
| Domain core | `packages/core` pure TS + zod | — | Deno+Node portable, 100% unit-testable |
| Database | Supabase Postgres | 15+ | system of record; pg_cron, pg_net, RLS |
| Scheduler | pg_cron → pg_net → Edge Functions | — | only free always-on sub-daily option (ADR-02) |
| Jobs runtime | Supabase Edge Functions (Deno) | — | 12 functions (11 scheduled + execute-bet), §6.12–6.20a |
| Web | Next.js (App Router, RSC) on Vercel | 15.x | dashboard + operator API |
| UI | Tailwind CSS + shadcn/ui + Recharts | — | edge-view bars, reliability diagrams, heatmaps |
| Data access | supabase-js + generated types | v2 | ADR-14 |
| Validation | zod (every external payload) | 3.x | research-fixture-backed schemas |
| Trading SDK | @polymarket/clob-client (dormant) | ^5.8.1 | verified maintained 2026-06 |
| Time | date-fns + @date-fns/tz | 4.x / 1.x | IANA zone math in core (no Temporal yet in all targets) |
| Tests | Vitest (+ fixtures from `research/*.json`) | 2.x | core unit + parser golden tests |
| E2E smoke | Playwright (dashboard), `scripts/smoke-live-apis.ts` (integrations) | — | §14 P8/P10 |
| CI | GitHub Actions: typecheck + vitest + build | — | non-critical weekly smoke cron only — ADR-02 bars GHA from critical schedules |
| Alerts | Slack incoming webhook | — | operator decision |

---

## 5. Project Structure

```
weather-edge/
├── ARCHITECTURE.md                  # this document
├── REQUIREMENTS.md                  # source spec (v2), copied verbatim
├── REVIEW.md                        # Phase-9 review findings (generated)
├── README.md                        # quickstart, system overview, links
├── RUNBOOK.md                       # operations: incidents, manual triggers, recovery
├── .env.example                     # every env var with comments (§11.2)
├── package.json                     # workspace root: scripts (dev/test/typecheck/build)
├── pnpm-workspace.yaml              # packages/*, apps/*
├── tsconfig.base.json               # strict, shared compiler options
├── vitest.workspace.ts              # test projects: core, db, web
├── .github/workflows/ci.yml         # typecheck + vitest + next build on PR/push
│
├── research/                        # ground-truth provenance (committed)
│   ├── REPORT-polymarket-api.md     # live-verified Polymarket facts
│   ├── REPORT-weather-data.md       # live-verified weather API facts
│   ├── REPORT-strategy-prior-art.md # fees/legal/methods/competition research
│   └── *.json / *.html / *.txt      # raw API samples → test fixtures
│
├── packages/
│   ├── core/                        # PURE domain logic — no IO, Deno+Node portable
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts             # public barrel export
│   │       ├── types.ts             # shared domain types (BucketDef, EdgeRow, …)
│   │       ├── errors.ts            # AppError taxonomy (§11.1)
│   │       ├── time.ts              # local-day windows, leads, DST-safe (§6.1)
│   │       ├── units.ts             # °C/°F, WU rounding replica (§6.2)
│   │       ├── buckets.ts           # bucket-label parsing, ladders, winners (§6.3)
│   │       ├── fees.ts              # taker fee curve, min-edge (§6.4)
│   │       ├── distributions/
│   │       │   ├── gaussian.ts      # Φ, Gaussian bucketization (§6.5)
│   │       │   ├── ensemble.ts      # ensemble stats, dressed empirical (§6.5)
│   │       │   ├── consensus.ts     # market-implied distribution (§6.5)
│   │       │   └── nowcast.ts       # running-max constraint (§6.5)
│   │       ├── calibration/
│   │       │   ├── emos.ts          # bias, σ, model weights (§6.6)
│   │       │   └── scores.ts        # Brier, ECE, reliability, sharpness (§6.6)
│   │       ├── edge.ts              # book walking, edge rows, filters (§6.7)
│   │       ├── kelly.ts             # joint Kelly, fraction, caps (§6.8)
│   │       ├── risk.ts              # breakers, exposure, clusters (§6.8)
│   │       ├── polymarket/
│   │       │   ├── gamma.ts         # event parsing, station extraction (§6.9)
│   │       │   └── clob.ts          # book normalization (§6.9)
│   │       ├── weather/
│   │       │   ├── openmeteo.ts     # URLs + parsers, request weights (§6.10)
│   │       │   ├── wu.ts            # WU obs parsing, key extraction (§6.10)
│   │       │   ├── metar.ts         # METAR parsing, running max (§6.10)
│   │       │   └── iem.ts           # IEM daily parsing (§6.10)
│   │       └── config.ts            # zod AppConfig schema + defaults (§6.11)
│   │   └── test/                    # vitest mirrors src/; fixtures from ../../research/
│   │
│   ├── io/                          # tiny IO helpers shared by ALL runtimes (no DB deps)
│   │   └── src/
│   │       ├── http.ts              # fetchJson — retry/backoff/timeout (§6.12)
│   │       └── slack.ts             # slackPost — raw webhook post, no dedup (§6.12)
│   │
│   ├── db/                          # database access (Node + Deno)
│   │   └── src/
│   │       ├── types.gen.ts         # supabase gen types output (CI-checked fresh)
│   │       └── queries/             # one file per domain: markets.ts, forecasts.ts,
│   │                                #   observations.ts, distributions.ts, bets.ts,
│   │                                #   calibration.ts, jobs.ts, config.ts
│   │
│   └── trading/                     # executor boundary (§6.20)
│       └── src/
│           ├── executor.ts          # TradeExecutor interface + PaperExecutor
│           ├── live.ts              # LiveExecutor (clob-client) — DORMANT
│           └── gate.ts              # goLiveGate()
│
├── supabase/
│   ├── config.toml
│   ├── migrations/                  # NNN_name.sql — schema, RLS, pg_cron schedules
│   │   ├── 0001_extensions.sql      # pg_cron, pg_net
│   │   ├── 0002_reference.sql       # cities, stations, city_stations, models
│   │   ├── 0003_ingestion.sql       # forecast_snapshots, ensemble_snapshots,
│   │   │                            #   observations, intraday_max, nowcast_lift
│   │   ├── 0004_markets.sql         # market_events, market_buckets, market_snapshots
│   │   ├── 0005_analytics.sql       # bucket_probabilities, model_stats, calibration_scores,
│   │   │                            #   edge_evaluations, model_stats_history
│   │   ├── 0006_trading.sql         # bets, bankroll_ledger
│   │   ├── 0007_ops.sql             # job_runs, job_locks, alerts_log, config, config_audit,
│   │   │                            #   backfill_progress
│   │   ├── 0008_rls.sql             # deny-by-default policies (ADR-13)
│   │   ├── 0009_cron.sql            # pg_cron schedule registrations (§7.22; CRON_SECRET via Vault)
│   │   └── 0010_seed.sql            # models seed, config defaults, clusters
│   │
│   └── functions/                   # Deno Edge Functions — thin orchestration only
│       ├── _shared/
│       │   ├── runJob.ts            # idempotency + job_runs + 202/waitUntil (§6.12)
│       │   ├── db.ts                # service-role client factory (§6.12)
│       │   ├── http.ts              # re-export shim → packages/io/http.ts (§6.12)
│       │   ├── slack.ts             # notifySlack = db dedup + packages/io slackPost (§6.12)
│       │   ├── auth.ts              # requireCronAuth (§6.12)
│       │   └── grading.ts           # gradeEvent — shared by 2 jobs (§6.12)
│       ├── discover-markets/index.ts    # §6.13
│       ├── snapshot-forecasts/index.ts  # §6.14
│       ├── snapshot-ensembles/index.ts  # §6.14
│       ├── fetch-actuals/index.ts       # §6.15
│       ├── metar-nowcast/index.ts       # §6.15
│       ├── build-distributions/index.ts # §6.16
│       ├── poll-markets/index.ts        # §6.17 (edge engine)
│       ├── run-calibration/index.ts     # §6.18
│       ├── grade-bets/index.ts          # §6.19 (safety sweep + live reconciliation)
│       ├── daily-digest/index.ts        # §6.19
│       ├── health-monitor/index.ts      # §6.19
│       └── execute-bet/index.ts         # §6.20a — on-demand executor host (NOT cron'd; ADR-10)
│
├── apps/
│   └── web/                         # Next.js 15 App Router on Vercel
│       ├── next.config.ts
│       └── src/
│           ├── app/
│           │   ├── layout.tsx               # shell, nav, auth guard
│           │   ├── page.tsx                 # / today overview
│           │   ├── events/[slug]/page.tsx   # edge view per event
│           │   ├── city/[slug]/page.tsx     # per-city calibration + history
│           │   ├── calibration/page.tsx     # Brier/ECE/reliability
│           │   ├── bets/page.tsx            # ledger
│           │   ├── system/page.tsx          # job health
│           │   ├── admin/page.tsx           # halts, config, verification
│           │   ├── login/page.tsx           # Supabase OTP
│           │   └── api/
│           │       ├── bets/[id]/approve/route.ts
│           │       ├── bets/[id]/skip/route.ts
│           │       ├── admin/halt/route.ts
│           │       ├── admin/resume/route.ts
│           │       ├── admin/config/route.ts
│           │       ├── admin/verify-station/route.ts
│           │       ├── admin/trigger-job/route.ts
│           │       ├── admin/promote-source/route.ts
│           │       ├── admin/manual-bet/route.ts
│           │       ├── admin/export/route.ts
│           │       └── health/route.ts
│           ├── lib/
│           │   ├── supabase.ts      # server/client helpers (cookie auth)
│           │   ├── loaders.ts       # RSC data loaders (§6.21)
│           │   └── format.ts        # °/$/date display helpers
│           └── components/
│               ├── EdgeChart.tsx            # house-vs-market bars + edge highlights
│               ├── DistributionOverlay.tsx  # ladder distribution comparison
│               ├── ReliabilityDiagram.tsx
│               ├── CalibrationHeatmap.tsx   # city × lead Brier/MAE grid
│               ├── BetCard.tsx              # rec with Kelly math + approve/skip
│               ├── ExposureBar.tsx          # caps utilization
│               ├── JobHealthTable.tsx
│               └── RunningMaxBadge.tsx      # intraday observed max
│
├── scripts/                         # local Node CLIs (tsx) — §6.22
│   ├── seed-stations.ts             # OurAirports → stations table
│   ├── backfill-forecasts.ts        # Previous Runs API, resumable
│   ├── backfill-actuals.ts          # WU/IEM historical daily maxes, resumable
│   ├── backfill-market-history.ts   # closed events + prices-history, best-effort
│   ├── simulate-historical-edge.ts  # replay: house vs market Brier + paper P&L
│   ├── smoke-live-apis.ts           # one call per integration, asserts shapes
│   ├── backup-db.ts                 # weekly pg_dump of the evidentiary core (F-037)
│   └── lib/                         # shared CLI plumbing (pg pool, progress, rate budget)
│
└── docs/
    ├── DATA-SOURCES.md              # every endpoint, params, quirks (from research)
    ├── CALIBRATION.md               # EMOS math, scoring definitions, promotion rules
    ├── TRADING-MATH.md              # fees, edge, joint Kelly worked examples
    └── GO-LIVE-CHECKLIST.md         # the gated path to real money
```

---

## 6. Module & Function Definitions

Type notation: TS-style. All temperatures are `number`; suffix conventions: `…C` = degrees Celsius (may be fractional), `…Native` = integer-ish value in the market's native unit (°F for US cities, °C otherwise). All instants are UTC `Date`/`timestamptz`; all local-day identities are ISO `YYYY-MM-DD` strings paired with an IANA `tz`.

Shared types (defined in `core/types.ts`, used throughout):

```ts
type Unit = 'F' | 'C'
type BucketDef = { label: string; lowNative: number | null; highNative: number | null; unit: Unit }
  // lowNative=null → "X or below" tail; highNative=null → "Y or higher" tail
type ForecastPoint = { model: string; tmaxC: number; leadDays: number; capturedAt: Date }
type NormalizedBook = { bestBid: number|null; bestAsk: number|null; bids: Level[]; asks: Level[];
                        tickSize: number; minOrderSize: number; hash: string }   // Level = {price, size}, best-first
type EdgeRow = { bucketIdx: number; q: number; bestAsk: number|null; execAsk: number|null;
                 spread: number|null; edge: number|null; evPerShare: number|null;  // = edge (q − execAsk), kept under the spec §3.3 name
                 feePerShare: number; minEdge: number; pass: boolean; reasons: string[] }
type StakePlan = { bucketIdx: number; kellyRaw: number; kellyFrac: number; cappedFrac: number;
                   stakeUsd: number; capAudit: string[] }
```

### 6.1 `core/time.ts` — local-day & lead arithmetic

Purpose: the single authority for "what local day is it at this station" — every other module that touches dates calls this; nothing else may do timezone math.

```
localDayWindow(tz: string, dateISO: string): { startUtc: Date; endUtc: Date }
  Purpose: UTC half-open interval [00:00, 24:00) of the local calendar day (WU/Polymarket window).
  Params: tz IANA name (e.g. 'Asia/Seoul'); dateISO 'YYYY-MM-DD'.
  Returns: exact UTC instants; correct across DST transitions (23h/25h days).
  Side effects: none. Error cases: InvalidTimezoneError on unknown tz.
  Called by: parsePreviousRunsHourly (§6.10), metarRunningMax (§6.10), targetDateFromEvent (§6.9),
             isLocalDayOver (§6.1), gradeEvent (§6.12 — ADR-16 cutoffs), simulateHistoricalEdge (§6.22),
             backfillForecasts (§6.22); fetchActuals/metarNowcast reach it via isLocalDayOver/metarRunningMax.
  Calls: @date-fns/tz primitives only.

localDateAt(tz: string, instant: Date): string
  Purpose: the local calendar date at a given instant — used to decide "is this obs part of day D".
  Returns: 'YYYY-MM-DD'. Side effects: none. Error cases: InvalidTimezoneError.
  Called by: leadDays (§6.1), parsePreviousRunsHourly (§6.10), metarRunningMax (§6.10),
             discoverMarkets (§6.13), gradeEvent (§6.12); fetchActuals/metarNowcast reach it via
             isLocalDayOver/metarRunningMax.
  Calls: @date-fns/tz.

leadDays(nowUtc: Date, targetDateISO: string, tz: string): number
  Purpose: whole-day lead time of a forecast/bet relative to the station's local calendar
           (0 = target day in progress locally; 1 = locally tomorrow; …).
  Returns: integer ≥ −1 (−1 = target day already over locally).
  Side effects: none. Error cases: InvalidTimezoneError.
  Called by: snapshotForecasts (§6.14), snapshotEnsembles (§6.14), buildDistributionForEvent (§6.16),
             pollMarkets (§6.17), runCalibration (§6.18), simulateHistoricalEdge (§6.22)
  Calls: localDateAt.

isLocalDayOver(tz: string, dateISO: string, nowUtc: Date): boolean
  Purpose: gate for actuals fetching: true once nowUtc ≥ endUtc of the local day.
  Called by: fetchActuals (§6.15), gradeBetsSweep (§6.19)
  Calls: localDayWindow.

localHour(tz: string, instant: Date): number
  Purpose: 0–23 local hour — selects stations "in daytime" for METAR polling and indexes the lift table.
  Called by: metarNowcast (§6.15), buildDistributionForEvent (§6.16 — lift-table row selection)
  Calls: @date-fns/tz.
```

### 6.2 `core/units.ts` — unit conversion & WU rounding replica

Purpose: encode exactly how the resolution source rounds, once. ADR-04: WU integers are never re-derived from converted values in the grading path — these helpers exist for forecasts (which arrive in °C and must be bucketized in native units) and for the METAR replica used in cross-checks.

```
cToF(c: number): number
  Purpose: exact linear conversion (c × 9/5 + 32), no rounding.
  Called by: gaussianBucketProbs callers via toNative (below), metarMaxToNative, format.ts (web).
  Calls: none.

fToC(f: number): number
  Purpose: inverse linear conversion, display/diagnostics only.
  Called by: web format.ts. Calls: none.

wuRound(x: number): number
  Purpose: WU display-rounding replica: round-half-up on the absolute value (30.6→31; −0.5→−1
           assumption documented; negative-half cases flagged for empirical confirmation in paper phase, A-11).
  Called by: metarMaxToNative. Calls: none.

toNative(tC: number, unit: Unit): number
  Purpose: convert a continuous °C forecast value into continuous native-unit degrees (no rounding) —
           the distribution is bucketized in native space (ADR-04).
  Called by: buildDistributionForEvent (§6.16), simulateHistoricalEdge (§6.22).
  Calls: cToF when unit='F'.

metarMaxToNative(maxTenthsC: number, unit: Unit): number
  Purpose: replicate WU's integer for a METAR tenths-°C max: unit='C' → wuRound(maxTenthsC);
           unit='F' → wuRound(cToF(maxTenthsC)). Used ONLY for cross-checks/nowcast, never grading.
  Called by: metarNowcast (§6.15), fetchActuals divergence check (§6.15).
  Calls: wuRound, cToF.
```

### 6.3 `core/buckets.ts` — bucket-label parsing, ladders, winners

Purpose: convert Polymarket's human bucket labels into machine ranges and back. This module failing silently = betting on the wrong temperature; it is fixture-tested against every label format observed in `research/gamma-event-*.json`.

```
parseBucketLabel(label: string): BucketDef
  Purpose: parse '94-95°F' → {low:94, high:95, unit:'F'}; '87°F or below' → {low:null, high:87};
           '19°C or higher' → {low:19, high:null}; **bare single-degree labels '15°C'/'94°F' →
           {low:N, high:N} — the DOMINANT interior shape on °C events (9 of 11 buckets in the live
           London/Paris/Seoul fixtures)**; tolerant of NBSP/EN-dash/whitespace/negative-degree variants.
  Returns: BucketDef. Side effects: none.
  Error cases: BucketParseError(label) on any unrecognized shape — caller must treat the whole
               event as unbettable and alert (never guess).
  Called by: parseGammaEvent (§6.9).
  Calls: none.

bucketRange(b: BucketDef): { lo: number; hi: number }
  Purpose: continuous integration bounds with ±0.5 continuity correction in native degrees:
           {94,95} → [93.5, 95.5); {15,15} → [14.5, 15.5); tails → ±Infinity on the open side.
  Called by: gaussianBucketProbs, dressedEnsembleProbs, applyRunningMaxConstraint (§6.5),
             validateLadder (§6.3), getEventDetail (§6.21).
  Calls: none.

validateLadder(buckets: BucketDef[]): { ok: boolean; problems: string[] }
  Purpose: assert exactly one low tail + one high tail, contiguous integer coverage, uniform unit,
           sorted ascending; guards against Polymarket changing ladder shape (currently 11 buckets,
           2°F US / 1°C intl — NOT assumed, verified per event).
  Called by: parseGammaEvent (§6.9), buildDistributionForEvent (§6.16).
  Calls: bucketRange.

winningBucket(buckets: BucketDef[], actualNative: number): number
  Purpose: index of the bucket containing the WU integer actual (whole-degree semantics: 93°F → '92-93°F').
  Returns: index 0..n−1.
  Error cases: LadderGapError if no bucket contains the value (impossible on a valid ladder; CRITICAL).
  Called by: gradeEvent (§6.12), simulateHistoricalEdge (§6.22).
  Calls: none.
```

### 6.4 `core/fees.ts` — fee curve & minimum edge

Purpose: the corrected economics (ADR-07). Fee rate is read per market from `feeSchedule.rate` (currently 0.05 everywhere) — never hardcoded.

```
takerFeePerShare(p: number, rate: number): number
  Purpose: Polymarket weather fee replica: rate × p × (1−p), in USDC per share (docs-verbatim formula).
  Params: p ∈ (0,1) execution price; rate from market feeSchedule (0.05).
  Called by: minEdgeRequired, computeBucketEdges (§6.7), pollMarkets (§6.17 — effective Kelly costs),
             simulateHistoricalEdge (§6.22); PaperExecutor.place and gradeEvent reach it via takerFeeTotal.
  Calls: none.

takerFeeTotal(p: number, shares: number, rate: number): number
  Purpose: shares × takerFeePerShare; convenience for fills/grading.
  Called by: PaperExecutor.place (§6.20), LiveExecutor.place (§6.20), gradeEvent (§6.12).
  Calls: takerFeePerShare.

minEdgeRequired(p: number, observedSpread: number, cfg: EdgeConfig): number
  Purpose: price-dependent trade threshold in probability points:
           uncertaintyMargin (default 0.05) + max(spreadBufferMin, observedSpread/2) + takerFeePerShare(p, rate).
  Returns: threshold compared against edge = q − execAsk.
  Called by: computeBucketEdges (§6.7).
  Calls: takerFeePerShare.
```

### 6.5 `core/distributions/*` — probability over the bucket ladder

Purpose: every method maps (inputs) → `number[]` aligned to the event's bucket ladder, summing to 1 ± 1e-9. All methods are pure; persistence happens in §6.16.

```
normCdf(x: number): number                                          [gaussian.ts]
  Purpose: standard normal Φ via Abramowitz-Stegun 7.1.26 erf approximation (|ε| < 7.5e-8 —
           three orders below any betting-relevant threshold; no dependency).
  Called by: gaussianBucketProbs, dressedEnsembleProbs. Calls: none.

gaussianBucketProbs(muNative: number, sigmaNative: number, buckets: BucketDef[]): number[]   [gaussian.ts]
  Purpose: P(b) = Φ((hi−μ)/σ) − Φ((lo−μ)/σ) per bucketRange; tails absorb the open mass; renormalize.
  Error cases: DistributionError if sigmaNative ≤ 0.2 (floor guard — degenerate σ means a
               calibration bug upstream, refuse to emit overconfident probabilities).
  Called by: buildDistributionForEvent (§6.16), simulateHistoricalEdge (§6.22).
  Calls: normCdf, bucketRange.

ensembleStats(points: ForecastPoint[], weights: Map<string, number>): { mu: number; spreadStd: number; n: number }   [ensemble.ts]
  Purpose: weighted mean of bias-corrected model points + their weighted std-dev (diagnostic only —
           σ for the Gaussian comes from calibration residuals, NOT this spread; underdispersion guard).
  Called by: buildDistributionForEvent (§6.16). Calls: none.

dressedEnsembleProbs(membersNative: number[], residualSigma: number, buckets: BucketDef[]): number[]   [ensemble.ts]
  Purpose: challenger method: each ensemble member contributes a Gaussian kernel N(member, residualSigma);
           bucket prob = mean over members of the kernel mass in the bucket.
  Error cases: DistributionError if members.length < 20 (don't pretend 5 points are a distribution).
  Called by: buildDistributionForEvent (§6.16). Calls: normCdf, bucketRange.

impliedDistribution(mids: (number|null)[]): number[] | null         [consensus.ts]
  Purpose: market-consensus benchmark: clamp mids to [0.001, 0.999], renormalize to Σ=1;
           1–2 missing mids (e.g. a null-bid tail, observed live on NYC's top tail) are floored at
           0.001 before renormalizing.
  Returns: null if >2 buckets lack a mid (too sparse to be a benchmark).
  Called by: pollMarkets (§6.17), backfillMarketHistory (§6.22).
  Calls: none.

applyRunningMaxConstraint(probs: number[], buckets: BucketDef[], runningMaxNative: number,
                          lift?: { p50: number; p90: number }): number[]   [nowcast.ts]
  Purpose: zero out buckets with hi < runningMaxNative (physically eliminated), shift partial mass for
           the bucket containing the running max using the empirical remaining-lift quantiles when
           provided, renormalize.
  Error cases: the open top tail (hi = +∞) can never be eliminated — when runningMax exceeds every
               closed bucket the result is [0,…,0,1] on the tail, NOT "unchanged"; an unchanged-with-
               warning return is reachable only on a ladder with no open tail, which validateLadder
               rejects upstream.
  Called by: buildDistributionForEvent (§6.16; target-day rebuilds triggered by metarNowcast).
  Calls: bucketRange.
```

### 6.6 `core/calibration/*` — EMOS-style correction & probabilistic scoring

```
updateBias(prevBias: number | null, error: number, alpha: number): number   [emos.ts]
  Purpose: decaying-average bias: bias ← α·error + (1−α)·prevBias (error = forecastC − observedC);
           prevBias=null seeds with error. α default 0.15 (config).
  Called by: runCalibration (§6.18), simulateHistoricalEdge walk-forward fit (§6.22).
  Calls: none.

fitSigma(residuals: number[], minN: number): { sigma: number; n: number } | null   [emos.ts]
  Purpose: std-dev of the last `window` residuals (corrected forecast − observed) per
           (station, model, lead); null when n < minN (default 8) — caller falls back to the
           lead-pooled or global prior σ ladder in config.
  Called by: runCalibration (§6.18), simulateHistoricalEdge (§6.22). Calls: none.

computeModelWeights(mseByModel: Map<string, number>): Map<string, number>   [emos.ts]
  Purpose: inverse-MSE weights normalized to Σ=1; models missing recent data get weight 0;
           single-model fallback weight 1.
  Called by: runCalibration (§6.18), simulateHistoricalEdge (§6.22). Calls: none.

correctPoint(rawC: number, bias: number): number   [emos.ts]
  Purpose: rawC − bias. Trivial by design — the value is that it is the ONLY place correction happens.
  Called by: buildDistributionForEvent (§6.16), simulateHistoricalEdge (§6.22). Calls: none.

brierScore(probs: number[], outcomeIdx: number): number   [scores.ts]
  Purpose: Σ (qᵢ − oᵢ)² over the ladder (multi-category Brier; 0 perfect, 2 worst).
  Called by: runCalibration (§6.18), gradeEvent (§6.12), simulateHistoricalEdge (§6.22).
  Calls: none.

expectedCalibrationError(preds: { q: number; hit: boolean }[], bins: number): number   [scores.ts]
  Purpose: weighted |mean-predicted − empirical-hit-rate| over probability bins (default 10).
  Called by: runCalibration (§6.18). Calls: reliabilityBins.

reliabilityBins(preds: { q: number; hit: boolean }[], bins: number):
  { lo: number; hi: number; meanQ: number; hitRate: number; n: number }[]   [scores.ts]
  Purpose: reliability-diagram data, persisted to calibration_scores.reliability jsonb.
  Called by: expectedCalibrationError, runCalibration (§6.18). Calls: none.

sharpness(probsRows: number[][]): number   [scores.ts]
  Purpose: mean max-bucket probability — distinguishes "calibrated but vague" from "calibrated and sharp".
  Called by: runCalibration (§6.18). Calls: none.

pairedBootstrapPValue(diffs: number[], iters: number = 2000, seed: number = 42): number   [scores.ts]
  Purpose: one-sided paired bootstrap on per-event Brier differences (house − market): resample with
           replacement iters times; p = fraction of resample means ≥ 0. Seeded RNG (mulberry32) for
           reproducible gate decisions. This is the statistical teeth of the go-live gate (C5: the
           0.95× point threshold alone passes on pure noise ≈30% of the time).
  Error cases: returns 1.0 when diffs.length < 30 (insufficient evidence is a failing gate, not an error).
  Called by: runCalibration (§6.18), adminPromoteSource server re-check (§6.21).
  Calls: none.
```

### 6.7 `core/edge.ts` — edge computation & liquidity filters

```
executableAsk(book: NormalizedBook, sizeShares: number): { avgPrice: number; fillableShares: number }
  Purpose: walk ask levels (best-first) accumulating size; average fill price for the intended stake —
           EV uses THIS, never top-of-book (spec §11.3).
  Returns: fillableShares < sizeShares signals insufficient depth.
  Called by: computeBucketEdges, PaperExecutor.place (§6.20).
  Calls: none.

computeBucketEdges(dist: number[], buckets: BucketDef[], books: (NormalizedBook | null)[],
                   marketRows: { feeRate: number; spread: number|null }[], cfg: EdgeConfig): EdgeRow[]
  Purpose: per bucket: q from dist; execAsk via executableAsk at cfg.probeStakeUsd; edge = q − execAsk;
           fee via takerFeePerShare(execAsk); spread carried onto the row; pass = edge ≥
           minEdgeRequired(execAsk, spread, cfg); reasons[] collects every failed criterion
           (auditable "why not", persisted hourly to edge_evaluations — F-038).
  Called by: pollMarkets (§6.17), simulateHistoricalEdge (§6.22), getEventDetail (§6.21 display recompute).
  Calls: executableAsk, takerFeePerShare, minEdgeRequired.

applyLiquidityFilters(row: EdgeRow, ev: { volume24h: number; secondsToLocalMidnight: number;
                      stationVerified: boolean; halted: boolean }, cfg: EdgeConfig): EdgeRow
  Purpose: vetoes appended to row.reasons: volume24h < cfg.minEventVolumeUsd ($2k default — see F-022
           for why not $10k); row.spread > cfg.maxSpread (5¢); time-to-resolution <
           cfg.minHoursBeforeClose (2h); station unverified; active halt.
  Called by: pollMarkets (§6.17).
  Calls: none.
```

### 6.8 `core/kelly.ts` + `core/risk.ts` — sizing & risk

```
jointKellyStakes(q: number[], prices: number[]): { fractions: number[]; c: number }   [kelly.ts]
  Purpose: joint log-wealth-optimal stakes for mutually exclusive buckets (research §6d):
           treat prices as state prices; sort candidates by q/p descending; find threshold c such that
           c = (1 − Σ_included qᵢ·0 … budget identity) via one-pass greedy: include while qᵢ/pᵢ > c
           where c = (1 − Σ_inc qᵢ) / (1 − Σ_inc pᵢ) recomputed per inclusion; stakes fᵢ = qᵢ − c·pᵢ
           for included, 0 otherwise. Fractions are of bankroll; Σfᵢ ≤ 1 by construction.
  Params: q = house probabilities; prices = EFFECTIVE cost per $1 payout — execAsk +
          takerFeePerShare(execAsk, rate) + paper slippage, computed by the caller (adversarial
          finding W4: a fee-blind solver oversizes stakes and can mis-order inclusion near ties);
          NaN/null buckets pre-filtered by caller.
  Returns: fractions aligned to input indices; c = implied cash multiplier (diagnostic, stored in audit).
  Error cases: KellyDomainError ONLY on true domain violations (p ≤ 0, q outside [0,1]). Callers
               pre-filter inputs to positive EFFECTIVE edge q > p (W20: with fee-adjusted prices,
               p' ≥ 1 is reachable on nowcast-certain buckets — exclusion, never a throw; the
               pre-filter also guarantees p < 1 and a positive denominator in c). Returns all-zero
               when nothing survives the pre-filter.
  Property invariants (tested — scoped to the q > p candidate set per ADR-08's hedge-exclusion
               policy): Σf ≤ 1; f > 0 ⇔ q/p > c within the set; gradient ≤ 0 for candidates the
               GREEDY excludes (NOT for policy-filtered buckets — their positive hedge-gradient is
               deliberately forgone); reduces to (q−p)/(1−p) for a single bucket.
  Called by: pollMarkets (§6.17), simulateHistoricalEdge (§6.22).
  Calls: none.

applyKellyFraction(fractions: number[], k: number): number[]   [kelly.ts]
  Purpose: multiply by k (default 0.25). Separate so the audit can show full vs fractional.
  Called by: pollMarkets (§6.17). Calls: none.

applyRiskCaps(proposed: { bucketIdx: number; frac: number }[], ctx: {
    bankrollUsd: number; eventOpenUsd: number; clusterOpenUsd: number; dayOpenUsd: number },
  cfg: RiskConfig): StakePlan[]   [kelly.ts]
  Purpose: clamp in order — per-trade (2%), per-event incl. existing open (5%), cluster (8%),
           daily (15%); floor to whole shares respecting orderMinSize (5); record every clamp in
           capAudit[] strings; drop stakes whose post-cap size < minStakeUsd (config, $5).
  Called by: pollMarkets (§6.17); the fill RPC re-implements the same ladder in plpgsql (§6.20 —
             parity-tested against this function).
  Calls: none.

evaluateBreakers(stats: { consecutiveLossesByCityLead: Map<string, number>; dailyPnlPct: number;
                 drawdownPct: number; rollingBrierByCity: Map<string, number>;
                 freshestForecastAgeH: number; freshestPriceAgeMin: number },
                 cfg: RiskConfig): { scope: string; reason: string }[]   [risk.ts]
  Purpose: pure evaluation of every circuit-breaker rule (F-027); returns halts to apply.
  Called by: runCalibration (§6.18), gradeEvent (§6.12), healthMonitor (§6.19).
  Calls: none.

exposureSummary(openBets: { eventId: string; citySlug: string; cluster: string; stakeUsd: number;
                targetDate: string }[], bankrollUsd: number):
  { byEvent: Map<string, number>; byCluster: Map<string, number>; byDay: Map<string, number> }   [risk.ts]
  Purpose: aggregates feeding applyRiskCaps ctx and the dashboard ExposureBar.
  Called by: pollMarkets (§6.17), getTodayOverview (§6.21); the fill RPC re-implements it in plpgsql
             (§6.20 — parity-tested).
  Calls: none.

clusterOf(city: { region: string }): string   [risk.ts]
  Purpose: correlated-exposure cluster key = seeded region (europe-west, europe-east, east-asia,
           south-asia, southeast-asia, mideast, africa, na-east, na-central, na-west, latam, oceania).
  Called by: pollMarkets (§6.17 — builds the cluster field exposureSummary consumes); the fill RPC
             reads cities.region directly (§6.20). Calls: none.
```

### 6.9 `core/polymarket/*` — Gamma & CLOB parsing (pure)

```
parseStringArray(s: string): string[]   [gamma.ts]
  Purpose: decode Polymarket's stringified-JSON fields (outcomes, outcomePrices, clobTokenIds,
           umaResolutionStatuses) — parse twice, validate array-of-strings.
  Error cases: GammaShapeError with the field name (a shape change here = upstream API change alert).
  Called by: parseGammaEvent, backfillMarketHistory (§6.22). Calls: none.

extractStationFromUrl(url: string): { icao: string; countryCode: string } | null   [gamma.ts]
  Purpose: from resolutionSource '…/history/daily/{cc}/…/{ICAO}': cc = FIRST segment after /daily/
           (uppercased), icao = TERMINAL segment matching ^[A-Z0-9]{4}$. Segment count between them
           VARIES — US URLs have two (us/ny/new-york-city/KLGA, live-verified), intl have one
           (gb/london/EGLC, fr/bonneuil-en-france/LFPB); never assume a fixed count.
           null on non-matching URL (triggers station-unverified path, never a guess).
  Called by: parseGammaEvent. Calls: none.

targetDateFromEvent(ev: { slug: string; title: string; gameStartTime: string | null }, tz?: string): string
  Purpose: target local date — primary: parse '…-on-{month}-{day}-{year}' slug; ALWAYS cross-check the
           title's month-day. gameStartTime is local midnight starting the target day expressed in UTC
           with a space-separated format ('2026-06-10 15:00:00+00'), so its UTC calendar date is the
           PREVIOUS day for APAC/EMEA cities (Seoul fixture: slug june-11 ↔ 2026-06-10T15:00Z) — the
           strict check is gameStartTime == localDayWindow(tz, slugDate).startUtc and runs ONLY when
           tz is known (existing city). For brand-new cities the check is skipped and tz is instead
           DERIVED from the slugDate↔gameStartTime offset, stored provisionally until the station's
           IANA tz is seeded. Mismatch with known tz → GammaShapeError (never bet a misdated event).
  Called by: parseGammaEvent. Calls: localDayWindow (when tz provided).

parseGammaEvent(ev: RawGammaEvent, knownTz?: string): ParsedEvent   [gamma.ts]
  Purpose: one raw Gamma event → typed: { slug, citySlug, targetDate, derivedTzOffset?, unit,
           station {icao, cc} | null,
           negRiskMarketId, kind: 'highest', buckets: Array<{ marketId, conditionId, label, def: BucketDef,
           tokenYes, tokenNo, bestBid, bestAsk, spread, tickSize, minOrderSize, feeRate, volume24h,
           outcomePricesResolved }> sorted by ladder order, eventVolume24h, liquidity, acceptingOrders }.
  Error cases: propagates BucketParseError/GammaShapeError; validateLadder problems attached as
               event.ladderProblems (event stored but flagged unbettable).
  Called by: discoverMarkets (§6.13), pollMarkets (§6.17), backfillMarketHistory (§6.22).
  Calls: parseStringArray, parseBucketLabel, validateLadder, extractStationFromUrl, targetDateFromEvent.

isZombieEvent(ev: RawGammaEvent, todayUtcISO: string): boolean   [gamma.ts]
  Purpose: endDate < today OR acceptingOrders missing/false with degenerate quotes (bid 0/ask 1) —
           verified live failure mode (stale Jinan events).
  Called by: discoverMarkets (§6.13), pollMarkets (§6.17). Calls: none.

normalizeBook(raw: RawClobBook): NormalizedBook   [clob.ts]
  Purpose: parse string numbers; REORDER to best-first (live-verified quirk: raw bids ascending,
           asks descending — best quote is the LAST element of each raw array); carry tick_size,
           min_order_size, hash.
  Error cases: ClobShapeError on missing arrays.
  Called by: pollMarkets (§6.17), PaperExecutor.place via stored book (§6.20).
  Calls: none.
```

### 6.10 `core/weather/*` — weather source URLs & parsers (pure)

```
forecastUrl(base: string, st: { lat: number; lon: number }, models: string[], days: number, apikey?: string): string   [openmeteo.ts]
  Purpose: multi-model daily snapshot URL: daily=temperature_2m_max, timezone=auto, forecast_days,
           models=comma-list; appends apikey when paid host. Model list from DB (enabled models),
           validated against the known-good set {ecmwf_ifs025, gfs_seamless, icon_seamless, jma_seamless,
           gem_seamless, meteofrance_seamless, ukmo_seamless, cma_grapes_global, best_match}.
  Called by: snapshotForecasts (§6.14). Calls: none.

parseMultiModelDaily(json: unknown, models: string[]): { model: string; targetDate: string; tmaxC: number }[]
  Purpose: read daily.time[] × temperature_2m_max_{model} suffixed arrays; skip nulls (per-model horizon).
  Error cases: OpenMeteoShapeError; per-model absence tolerated (logged), total absence fatal.
  Called by: snapshotForecasts (§6.14), backfillForecasts pseudo-truth mode (§6.22, via
             historicalForecastUrl), fetchActuals ERA5 path (§6.15, via parseEra5Daily wrapper).
  Calls: none (zod schema).

previousRunsUrl(base: string, st, models: string[], leads: number[], dates?: { start: string; end: string }, apikey?): string
  Purpose: hourly=temperature_2m,temperature_2m_previous_day1..7 URL (daily-max not supported there);
           optional start/end for backfill.
  Called by: snapshotForecasts gap-fill (§6.14), backfillForecasts (§6.22). Calls: none.

parsePreviousRunsHourly(json: unknown, models: string[], leads: number[], tz: string):
  { model: string; leadDays: number; targetDate: string; tmaxC: number }[]
  Purpose: group hourly series by local day (localDayWindow), take max per (model, lead, day);
           drops days with < 20 hourly points (partial-day guard).
  Called by: snapshotForecasts gap-fill (§6.14), backfillForecasts (§6.22).
  Calls: localDayWindow, localDateAt.

ensembleUrl(base, st, model: string, days: number, apikey?): string   +
parseEnsembleDaily(json: unknown): { member: number; targetDate: string; tmaxC: number }[]
  Purpose: per-member daily=temperature_2m_max from the ensemble API — ONE MODEL PER CALL (two calls:
           ecmwf_ifs025, gfs05). Single-model responses use the fixture-verified scheme (bare control
           variable + `_memberNN` suffixes, control stored as member 0); the multi-model name-mangled
           variant has no saved fixture and is deliberately avoided (adversarial I2).
  Called by: snapshotEnsembles (§6.14). Calls: none.

archiveUrl(base: string, st, dates: { start: string; end: string }, apikey?): string   +
parseEra5Daily(json: unknown): { date: string; tmaxC: number }[]   [openmeteo.ts]
  Purpose: ERA5T daily Tmax (default model blend, ~1-day lag) for the observations sanity column (F-008).
  Called by: fetchActuals (§6.15). Calls: parseMultiModelDaily internals (shared daily parser).

historicalForecastUrl(base: string, st, models: string[], dates: { start: string; end: string }, apikey?): string   [openmeteo.ts]
  Purpose: day-0 stitched pseudo-truth series (NOT lead-time data — see research) for backfill baselines.
  Called by: backfillForecasts (§6.22). Calls: none.

requestWeight(varsCount: number, daysSpan: number): number   [openmeteo.ts]
  Purpose: replicate Open-Meteo's fractional call accounting (>10 vars or >14 days ⇒ multiples) so the
           rate budgeter can stay under 600/min, 5k/h, 10k/day.
  Called by: backfillForecasts budgeter (§6.22), snapshotForecasts (§6.14). Calls: none.

wuObsUrl(icao: string, cc: string, unit: 'e' | 'm', yyyymmdd: string, apiKey: string): string   [wu.ts]
  Purpose: api.weather.com v1 observations/historical URL for {ICAO}:9:{CC}, startDate=endDate.
  Called by: fetchActuals (§6.15), backfillActuals (§6.22). Calls: none.

extractWuApiKey(html: string): string | null   [wu.ts]
  Purpose: regex the 32-hex public frontend key out of a wunderground.com history page (runtime
           extraction — never hardcoded; cached in config with TTL; rotation-resilient).
  Called by: fetchActuals key-refresh path (§6.15). Calls: none.

parseWuObservations(json: unknown): { validTimeGmt: number; tempInt: number | null }[]   [wu.ts]
  Purpose: typed obs list from the v1 payload (temp is WU's server-rounded integer in requested unit).
  Error cases: WuShapeError; empty observations[] returns [] (caller decides retry vs no-data).
  Called by: fetchActuals (§6.15), backfillActuals (§6.22). Calls: none.

wuDailyMax(obs: ReturnType<typeof parseWuObservations>): { maxInt: number; nObs: number } | null
  Purpose: max of non-null tempInt; null when no usable obs; nObs persisted (low counts → suspicious).
  Called by: fetchActuals (§6.15), backfillActuals (§6.22). Calls: none.

isFinalized(nextDayObs: { validTimeGmt: number }[]): boolean   [wu.ts]
  Purpose: Polymarket's finalization rule replica: ≥1 observation exists for the FOLLOWING local day.
  Called by: fetchActuals (§6.15). Calls: none.

parseMetarJson(json: unknown): { icaoId: string; obsTimeUtc: number; tempTenthsC: number }[]   [metar.ts]
  Purpose: aviationweather.gov array → typed obs (temp float °C, may be tenths).
  Called by: metarNowcast (§6.15), fetchActuals divergence check (§6.15). Calls: none.

metarRunningMax(obs: …[], tz: string, dateISO: string): number | null   [metar.ts]
  Purpose: max temp over obs with localDateAt(obsTime) == dateISO; null when none.
  Called by: metarNowcast (§6.15), fetchActuals (§6.15).
  Calls: localDayWindow, localDateAt.

iemDailyUrl(station: string, network: string, dateISO: string): string   +
parseIemDaily(json: unknown): { maxTmpF: number } | null   +
iemNetworkFor(cc: string, icao: string): { network: string; station: string }   [iem.ts]
  Purpose: secondary daily-max opinion; network convention: US → '{ST}_ASOS' w/ 3-letter id (ORD),
           intl → '{CC}__ASOS' w/ full ICAO (KR__ASOS/RKSI — two underscores, live-verified).
  Called by: fetchActuals (§6.15), backfillActuals (§6.22). Calls: none.
```

### 6.11 `core/config.ts` — runtime configuration schema

```
ConfigSchema: zod object — every tunable with defaults:
  bankrollUsd 1000 · kellyFraction 0.25 · perTradeCapPct 0.02 · perEventCapPct 0.05 ·
  clusterCapPct 0.08 · dailyCapPct 0.15 · uncertaintyMargin 0.05 · spreadBufferMin 0.01 ·
  minEventVolumeUsd 2000 · maxSpread 0.05 · minHoursBeforeClose 2 · maxLeadDays 7 · probeStakeUsd 20 ·
  minStakeUsd 5 · paperSlippage 0.01 · paperBookMaxAgeMin 5 · biasAlpha 0.15 · sigmaWindowDays 30 ·
  sigmaMinN 8 · sigmaFloorC 0.45 (floor applied in °C, before native conversion) ·
  priorSigmaByLead [1.6,1.9,2.3,2.7,3.1,3.5,3.9,4.3] (°C, lead 0..7) ·
  breakerConsecLosses 8 · breakerDailyLossPct 0.05 · breakerDrawdownPct 0.25 · breakerBrier 0.30 ·
  staleForecastHaltH 30 · stalePriceHaltMin 30 · championSource 'house_gaussian' ·
  autoApproveMaxStakeUsd 0 (Phase A manual-only; §12 Phase B raises it) ·
  jobWallLimitSec 150 (INVARIANT: ≥ the platform's max isolate lifetime incl. waitUntil — this single
  value parameterizes the job_locks lease expiry, runJob's 409-vs-takeover age test, and the
  health-monitor reaper; setting it below a job's true runtime re-opens the C8/W16 races) ·
  tradingMode 'paper' · wuApiKey (cached) · wuKeyFetchedAt

parseConfigRows(rows: { key: string; value: string }[]): AppConfig
  Purpose: merge DB config over defaults; zod-validate; throw ConfigError listing every invalid key.
  Called by: every job via runJob ctx (§6.12), web loaders (§6.21), scripts (§6.22).
  Calls: none.
```

### 6.12 `supabase/functions/_shared/*` — job runtime helpers

```
runJob(name: string, periodKey: string, handler: (ctx: JobCtx) => Promise<JobStats>): Promise<Response>   [runJob.ts]
  Purpose: the universal job wrapper. Sequence: requireCronAuth → claim the period: insert job_runs
           (name, periodKey, attempt=1) — on conflict, 409 ONLY if the existing row is 'ok', or
           'running' and younger than the job's wall-clock limit; a stale 'running' row (killed
           isolate) is taken over by CAS, not insert (W16 — unique key forbids a second row and a
           bare update races the reaper): `UPDATE job_runs SET status='running', started_at=now(),
           attempt=attempt+1 WHERE job=$1 AND period_key=$2 AND status='running' AND
           started_at=$observed RETURNING` — no row returned ⇒ someone else claimed it ⇒ 409.
           A 'failed' row is likewise claimable (same CAS with status IN ('running','failed') and
           the staleness guard); manual retriggers use fresh ':manual:{ts}' keys regardless. The
           "young" age test and the reaper both use cfg.jobWallLimitSec (§6.11 invariant) →
           respond 202 immediately → continue via EdgeRuntime.waitUntil: build JobCtx {db, config,
           log, startedAt} → handler → update job_runs (status, stats, durationMs) → on throw:
           update job_runs status='failed' + notifySlack(CRITICAL JOB_FAIL) (never rethrows).
  Params: periodKey examples — 'snapshot-forecasts:2026-06-10T10Z', 'poll-markets:2026-06-10T10:05'.
  Returns: HTTP Response (202 | 409 | 401) — pg_net's ~5s timeout only ever sees these fast paths.
  Side effects: job_runs rows, Slack on failure.
  Called by: every Edge Function index.ts (§6.13–6.19).
  Calls: requireCronAuth, getServiceDb, parseConfigRows, notifySlack.

getServiceDb(): SupabaseClient<Database>   [db.ts]
  Purpose: service-role client (env SUPABASE_URL + SERVICE_ROLE_KEY); singleton per isolate.
  Called by: runJob, gradeEvent, notifySlack (dedup), executeBet (§6.20a). Calls: none.

fetchJson(url: string, init?: RequestInit, opts?: { retries?: number; backoffMs?: number;
          timeoutMs?: number }): Promise<unknown>   [packages/io/http.ts — shared by functions, trading, scripts]
  Purpose: fetch with timeout (default 20s), retry on 429/5xx/network (default 2 retries, exponential
           backoff + jitter), JSON parse.
  Error cases: UpstreamError { source: hostname, status, retryable } after retries exhausted.
  Called by: every job that reaches an external API (§6.13–6.15, §6.17, §6.19), goLiveGate (§6.20),
             PaperExecutor.place (§6.20), seedStations/backfillMarketHistory/smokeLiveApis (§6.22).
  Calls: none.

notifySlack(alert: { kind: AlertKind; severity: 'INFO'|'ACTION'|'WARN'|'CRITICAL'; title: string;
            body: string; link?: string; dedupeKey?: string }): Promise<void>   [slack.ts]
  Purpose: post Block-Kit message to SLACK_WEBHOOK_URL; when dedupeKey present, insert into alerts_log
           `sent=false` first (unique on dedupeKey+day; conflict with a `sent=true` row ⇒ skip post,
           conflict with `sent=false` ⇒ retry that row) → post → flip `sent=true` on HTTP 2xx only
           (ADR-11: a failed post never consumes the dedupe key). Slack failure logs but never throws;
           health-monitor re-sends unsent rows; BET_REC additionally records delivery status in
           bets.audit.slack_delivered.
  Called by: runJob, discoverMarkets, snapshotForecasts, fetchActuals, buildDistributionForEvent,
             pollMarkets, runCalibration, gradeEvent, gradeBetsSweep, healthMonitor, dailyDigest,
             adminHalt (§6.21). (Scripts use packages/io slackPost directly — no DB dedup needed for CLI output.)
  Calls: slackPost (packages/io), getServiceDb (for dedup).

requireCronAuth(req: Request): void   [auth.ts]
  Purpose: constant-time compare of header 'x-cron-secret' against env CRON_SECRET (pg_cron passes it;
           admin trigger-job and the approve proxy pass it server-side). 401 on mismatch.
  Called by: runJob, executeBet (§6.20a). Calls: none.

gradeEvent(db, cfg, eventId: string): Promise<{ graded: boolean; winnerIdx?: number; mismatch?: boolean }>   [grading.ts]
  Purpose: the single grading path (called from fetch-actuals on finalization AND the safety sweep):
           load event + ladder + finalized observation → winningBucket → CLAIM the grade:
           `UPDATE market_events SET winning_bucket_idx=$w, resolved_at=now() WHERE id=$event AND
           winning_bucket_idx IS NULL RETURNING` — no row ⇒ another grader already won; abort
           (concurrent fetch-actuals + sweep produce exactly one grading pass) → for each open/filled
           bet on the event:
           conditional status update to resolved_win/resolved_lose (ADR-09),
           pnl = (win ? shares×(1−price) : −shares×price) − fees, ledger entry (unique per bet) →
           compare winner vs Polymarket's own resolved outcomePrices when present; mismatch ⇒
           notifySlack CRITICAL + flag event.grading_mismatch → SCORING per ADR-16: for each (source,
           lead ∈ {0,1}) select the time-matched scored row (last made_at ≤ cutoff, nowcast=false),
           append the lead to that row's scored_for_leads[] guarded by
           `WHERE NOT (scored_for_leads @> ARRAY[$lead])` (one row may carry both leads — W18; the
           guard plus the winner-claim gate make double-appends impossible) + write brier;
           nowcast rows scored under tag 'nowcast' → notifySlack INFO RESOLUTION
           (city, winner, our q vs market p, bet outcomes; deduped per event) →
           evaluateBreakers (consecutive losses).
  Idempotent: the winner-claim CAS is the gate (re-runs and concurrent invocations abort cleanly);
              ledger uniqueness and the scored_for_leads append guard back it up.
  Called by: fetchActuals (§6.15), gradeBetsSweep (§6.19).
  Calls: winningBucket, takerFeeTotal, brierScore, localDayWindow (ADR-16 cutoffs), localDateAt,
         evaluateBreakers, notifySlack, getServiceDb.
```

### 6.13 Job `discover-markets` — market & city ingestion

Schedule: `10 2,4,5,11,17 * * *` (UTC) — after each creation wave. Period key: `discover-markets:{date}T{hour}Z`. Budget: ~3 Gamma calls, <10s.

```
discoverMarkets(ctx): Promise<JobStats>
  Purpose: paginate Gamma events?tag_id=104596&active=true&closed=false (limit 100, offset step,
           until short page) → for each non-zombie event: parseGammaEvent (passing the city's known
           IANA tz when the city exists; for brand-new cities the tz offset is derived from
           gameStartTime per §6.9 and stored provisionally until the station row supplies the IANA
           zone) → upsert city (slug; new city ⇒ betting_enabled false + Slack WARN 'new city
           discovered') → station handling: extractStationFromUrl result
           vs current city_stations row — new/changed ICAO ⇒ close old row (valid_to=now), insert new
           (verified=false), suspend betting_enabled, Slack CRITICAL STATION_CHANGE; a brand-new ICAO
           additionally inserts a PROVISIONAL stations row (tz from the derived gameStartTime offset,
           lat/lon null until seed-stations/manual entry — satisfies the FK without a circular
           wait-for-operator bootstrap); unchanged ⇒ touch
           cities.last_seen → upsert market_events + market_buckets (ladder, tokens, tick, fees) →
           mark events past endDate+2d closed-by-us if Gamma stopped returning them.
  After upserts: tail-call buildDistributionForEvent (§6.16) for every event seen for the FIRST time
           — guarantees a house row exists hours before the earliest ADR-16 cutoff (C7; fixture
           timelines: NYC created 02:01 UTC vs lead-1 cutoff 04:00; Wellington created 04:01 UTC on
           D−2 vs lead-1 cutoff 11:00 UTC D−2).
  Stats: { eventsSeen, eventsNew, bucketsUpserted, stationsChanged, zombies, distributionsSeeded }.
  Error cases: per-event parse failures collected (event stored flagged unbettable), job continues;
               UpstreamError fails the run (next scheduled wave retries naturally).
  Called by: runJob handler registration; adminTriggerJob (§6.21).
  Calls: fetchJson, parseGammaEvent, isZombieEvent, localDateAt, buildDistributionForEvent (§6.16),
         notifySlack, db.queries.markets.
```

### 6.14 Jobs `snapshot-forecasts` + `snapshot-ensembles` — forecast capture

Schedules: `15 10,22 * * *` and `35 10,22 * * *` (after 00Z/12Z model availability, §9 timing table in weather report). Period keys: `{job}:{date}T{10|22}Z`. Budget: 49 stations ≈ 49+49 weighted Open-Meteo calls per run — ~300/day vs 10k limit.

```
snapshotForecasts(ctx): Promise<JobStats>
  Purpose: for every station referenced by an active city: forecastUrl(all enabled models, 16d) →
           parseMultiModelDaily → rows {station, model, target_date, tmax_c, lead_days(leadDays),
           captured_at} upserted on natural key (station, model, target_date, snapshot_slot) →
           GAP-FILL: query expected-vs-present matrix for the last 7 days; for stations with holes,
           previousRunsUrl + parsePreviousRunsHourly to repair (source='previous_runs').
  Stats: { stations, rowsUpserted, gapsRepaired, modelsMissing[] }.
  Error cases: per-station UpstreamError ⇒ skip station, collect, WARN when >20% stations failed;
               a model returning all-null for 3 consecutive runs ⇒ Slack WARN MODEL_DEGRADED.
  Called by: runJob; adminTriggerJob. 
  Calls: fetchJson, forecastUrl, parseMultiModelDaily, previousRunsUrl, parsePreviousRunsHourly,
         leadDays, requestWeight, notifySlack, db.queries.forecasts.

snapshotEnsembles(ctx): Promise<JobStats>
  Purpose: same loop with ensembleUrl(['ecmwf_ifs025','gfs05'], 16d) → parseEnsembleDaily →
           ensemble_snapshots rows (member arrays aggregated per station/model/target/slot).
  Called by: runJob; adminTriggerJob.
  Calls: fetchJson, ensembleUrl, parseEnsembleDaily, leadDays, db.queries.forecasts.
```

### 6.15 Jobs `fetch-actuals` + `metar-nowcast` — truth pipeline

Schedules: `20 * * * *` (hourly) and `*/15 * * * *`. Period keys: hourly/quarter-hour stamps.

```
fetchActuals(ctx): Promise<JobStats>
  Purpose: select stations where isLocalDayOver(date) for any unfinalized observation date within
           the last 5 days (first attempt ≥1h after local midnight) → ensure WU key: config cache
           older than 7d or last call 401 ⇒ refetch a WU history page, extractWuApiKey, store
           (failure ⇒ CRITICAL WU_KEY alert + rely on METAR provisional) → wuObsUrl(units: city unit)
           → parseWuObservations → wuDailyMax → upsert observations (tmax_wu_native, n_obs,
           provisional) → finalization probe: fetch following local day's obs; isFinalized ⇒ set
           finalized_at, then divergence checks: metarRunningMax+metarMaxToNative vs WU (≥1° ⇒ WARN
           DATA_DIVERGENCE), parseIemDaily vs WU (≥2°F ⇒ WARN) → ERA5T daily pull for the date via
           archiveUrl/parseEra5Daily (sanity column) → for each event on (city,date): gradeEvent.
  Stats: { stationsChecked, observationsUpserted, finalized, graded, divergences }.
  Error cases: WU 4xx/5xx per station ⇒ retry next hourly run (sweep guarantees eventual grading);
               persistent 48h failure ⇒ CRITICAL.
  Called by: runJob; adminTriggerJob.
  Calls: isLocalDayOver, wuObsUrl, extractWuApiKey, parseWuObservations, wuDailyMax, isFinalized,
         parseMetarJson, metarRunningMax, metarMaxToNative, iemDailyUrl/parseIemDaily/iemNetworkFor,
         archiveUrl/parseEra5Daily, fetchJson, gradeEvent, notifySlack, db.queries.observations.

metarNowcast(ctx): Promise<JobStats>
  Purpose: stations whose localHour ∈ [6, 24) (daytime/evening) with an open target-day event →
           ONE batched aviationweather call (ids=comma-list, hours=18) → per station:
           metarRunningMax → upsert intraday_max (station, date, max_tenths_c, max_native,
           updated_at) when increased → stations whose running max increased AND have a target-day
           distribution: re-run distribution build for that event (nowcast variant, §6.16 logic
           invoked in-process via shared module, not HTTP).
  Stats: { stationsPolled, maxesAdvanced, nowcastsRebuilt }.
  Called by: runJob.
  Calls: localHour, fetchJson, parseMetarJson, metarRunningMax, metarMaxToNative,
         buildDistributionForEvent (§6.16 export), db.queries.observations.
```

### 6.16 Job `build-distributions` — house & challenger probabilities

Schedule: `50 10,22 * * *` + invoked in-process by metar-nowcast (target-day) and after run-calibration. Period key: `build-distributions:{date}T{slot}` (in-process calls bypass runJob and write their own rows idempotently).

```
buildDistributions(ctx): Promise<JobStats>
  Purpose: for every open market_event with a verified station and lead_days ∈ [0, 7]: call
           buildDistributionForEvent for each enabled source.
  Called by: runJob; adminTriggerJob; runCalibration tail (§6.18).
  Calls: buildDistributionForEvent, db.queries.markets.

buildDistributionForEvent(db, cfg, eventId: string, sources: SourceName[]): Promise<RowCounts>
  Purpose: shared builder (also imported by metar-nowcast):
           load ladder (validateLadder — problems ⇒ skip + flag) + latest forecast snapshot set +
           model_stats for (station, lead, **slot of the snapshot being used** — 10Z and 12Z-set
           forecasts have different information ages, so their stats are never pooled, W3) →
           house_gaussian: per model correctPoint(raw, bias); ensembleStats(points, weights) → μC;
             σC = stored residual σ for (station, blend, lead, slot) else priorSigmaByLead[lead],
             floored at sigmaFloorC; toNative(μ), σ scaled ×9/5 for °F; gaussianBucketProbs →
           house_ensemble: latest ensemble_snapshots members (≥20 else skip) corrected by ensemble-
             model bias, toNative, dressedEnsembleProbs(members, σ_residual) →
           target-day (lead 0): intraday_max present ⇒ applyRunningMaxConstraint(probs, runningMax,
             lift table row for localHour) on every house source; flag nowcast=true →
           write bucket_probabilities rows (one per source per bucket) with made_at, inputs_hash
           (sha256 of snapshot ids + stats version + config version) — unchanged hash ⇒ skip write.
  Slot selection: stats are read for the slot of the snapshot set being used; 'gapfill' rows map to
           the nearest slot by captured_at; 'backfill' never feeds live builds (W19).
  Error cases: DistributionError (degenerate σ, too-few members) ⇒ skip source, WARN (notifySlack,
               deduped once per day per event).
  Called by: buildDistributions, discoverMarkets (§6.13 — ADR-16 row-existence seed), metarNowcast (§6.15).
  Calls: validateLadder, correctPoint, ensembleStats, toNative, gaussianBucketProbs,
         dressedEnsembleProbs, applyRunningMaxConstraint, localHour (nowcast_lift row selection),
         leadDays, notifySlack, db.queries.distributions (reads stored model_stats — no in-process fitting).
```

### 6.17 Job `poll-markets` — price ingestion & the edge engine

Schedule: `*/5 * * * *`. Period key: `poll-markets:{iso-minute}`. Budget: 2 Gamma pages + ≤15 CLOB books per cycle, <30s wall.

```
pollMarkets(ctx): Promise<JobStats>
  Purpose: the trading brain, one pass:
    (0) LEASE — claim the job_locks row via one CAS UPDATE (job='poll-markets', holder=runId,
        expires_at=now()+cfg.jobWallLimitSec WHERE expires_at < now() RETURNING): no row returned ⇒
        exit 'overlapped' (job_runs row finalized status 'ok' with stats {overlapped:true} so the
        reaper sees a terminal state). A lease row — NOT a pg advisory lock — because supabase-js
        rides PostgREST's connection pool, where session-scoped advisory locks bind to arbitrary
        pooled backends, leak on isolate kill, and fail toward a permanent self-DoS (C8); the lease
        auto-expires at jobWallLimitSec (≥ isolate lifetime, so a live run can never outlast its own
        lease). Released in the handler's finally-path with `WHERE job='poll-markets' AND
        holder=$runId` — a zombie's late release can never unlock an active holder.
    (1) PRICES — Gamma tag query paginated until short page (>4 pages ⇒ WARN universe growth, W13);
        cheap structural guards on every event + full zod validation of ONE sampled event per run
        (2s-CPU budget, W15; cpuMs recorded in stats) → per open event: parseGammaEvent → upsert
        market_snapshots per bucket ONLY when |mid − last_mid| ≥ 0.005 OR the tiered heartbeat
        elapsed (30 min for candidate events — lead ≤ 2 + acceptingOrders — and 2 h for the rest,
        §7.11 storage budget; unique (bucket_id, captured_at) as the backstop);
        refresh market_events liveness fields.
    (2) CONSENSUS — impliedDistribution(mids) per event → bucket_probabilities source='market_consensus'
        (same dedupe-by-hash as §6.16).
    (3) CANDIDATES — events bettable (station verified, betting_enabled, no halt, acceptingOrders,
        leadDays ≤ cfg horizon): load champion house distribution (freshness ≤ 14h else skip+count) →
        quick screen edge_q = q − bestAsk ≥ minEdge/2 → for screened buckets fetch CLOB book →
        normalizeBook → store book top-3 levels on the snapshot row.
    (4) EDGES — computeBucketEdges + applyLiquidityFilters per candidate event.
    (5) SIZING — per event with ≥1 passing bucket: jointKellyStakes over the PASSING buckets only
        (sizing exactly what can be recommended — ADR-08), inputs (q[], effectiveCost[]) where
        effectiveCost_i = execAsk_i + takerFeePerShare(execAsk_i, feeRate) + cfg.paperSlippage
        (fee-aware Kelly — W4; q > effectiveCost guaranteed by the pass filter) →
        applyKellyFraction(0.25) → exposureSummary(open bets) → applyRiskCaps → StakePlans ≥ minStakeUsd.
    (6) RECOMMENDATIONS — upsert bets (status 'recommended', natural key event+bucket+side) with the
        full audit object {q, execAsk, book hash, μ, σ, model weights version, dist row id, config
        version, kelly c, capAudit}; price moved >1¢ since an existing open rec ⇒ refresh row +
        re-notify only if stake changes ≥20%; Slack ACTION BET_REC (dedupe per bet+price-band).
    (7) EXPIRY — open recommendations whose edge < minEdge/2 or t-to-close < 2h ⇒ conditional
        UPDATE … WHERE status='recommended' → 'expired' (ADR-09: a concurrent approval wins the race
        cleanly, the loser 409s), Slack INFO BET_EXPIRED (batch). Live mode: a resting unfilled live
        order on an expiring rec is pulled via execute-bet {action:'cancel'} (HTTP — chokepoint intact).
    (8) AUDIT — on the first tick of each hour, persist ALL EdgeRows (passing AND failing, with
        reasons) for candidate events to edge_evaluations (F-038; 30-day retention).
    (9) POSITION WATCH — filled open bets: WARN once when current champion q < ½ entry q (ADR-17;
        display + alert only, never auto-exit).
  Stats: { events, pages, snapshotsWritten, booksFetched, recommendationsNew, refreshed, expired,
           evaluationsPersisted, cpuMs }.
  Error cases: Gamma UpstreamError ⇒ fail run (next 5-min tick retries); single-book failures ⇒
               bucket excluded with reason 'book_unavailable'.
  Called by: runJob; adminTriggerJob.
  Calls: fetchJson, parseGammaEvent, isZombieEvent, impliedDistribution, normalizeBook,
         computeBucketEdges, applyLiquidityFilters, takerFeePerShare, jointKellyStakes,
         applyKellyFraction, exposureSummary, clusterOf, applyRiskCaps, leadDays, notifySlack,
         executeBet (live-mode cancel via HTTP, §6.20a), db.queries.{markets,distributions,bets}.
```

### 6.18 Job `run-calibration` — daily learning loop

Schedule: `30 11 * * *` (after the 10:15 snapshot and most finalizations). Period key: `run-calibration:{date}`.

```
runCalibration(ctx): Promise<JobStats>
  Purpose: (1) RESIDUALS — for observations finalized since last run: join forecast_snapshots
           (every model, lead 0–7) → residual = corrected_tmax_c − observed_tmax_c (observed °C from
           native via exact conversion for °F cities — diagnostics only, grading never converts) →
           (2) STATS — per (station, model, lead, slot): updateBias; fitSigma over sigmaWindowDays;
           per (station, lead, slot): computeModelWeights from rolling MSE → upsert model_stats
           (versioned: stats_version increments per run; 10Z/22Z never pooled — W3; residuals from
           'backfill'/'gapfill' snapshot rows seed BOTH slots with σ widened ×1.15 — their
           information age matches neither slot, and forward residuals progressively dominate via
           the rolling window, W19) →
           (3) SCORES — per (city, lead, source) over rolling 30/60/90-day windows computed on
           ADR-16 time-matched scored rows ONLY: brierScore set, expectedCalibrationError,
           reliabilityBins, sharpness → upsert calibration_scores; plus the pooled paired-bootstrap
           p-value on per-event Brier diffs (champion vs market_consensus, 60d window) persisted for
           goLiveGate (F-019) →
           (4) GATES — evaluateBreakers (rolling Brier > 0.30 per city ⇒ halt city); champion-vs-
           market check: house Brier ≥ market_consensus Brier on the 30d window ⇒ Slack WARN
           CALIB_DRIFT (betting continues only if 60d window still passes; both fail ⇒ auto-halt all) →
           (5) PROMOTION REPORT — challenger beating champion ≥5% on 60d (time-matched) ⇒ Slack
           ACTION suggesting /admin promotion → (6) tail-call buildDistributions to refresh with new
           stats → (7) weekly (Sundays): rebuild nowcast_lift quantiles from accumulated
           observations/intraday history (§7.8a).
  Stats: { residualsAdded, statsUpserted, scoresUpserted, halts, promotionCandidates }.
  Called by: runJob; adminTriggerJob.
  Calls: updateBias, fitSigma, computeModelWeights, brierScore, expectedCalibrationError,
         reliabilityBins, sharpness, pairedBootstrapPValue, leadDays, evaluateBreakers,
         buildDistributions, notifySlack, db.queries.calibration.
```

### 6.19 Jobs `grade-bets` (sweep) + `daily-digest` + `health-monitor`

```
gradeBetsSweep(ctx): Promise<JobStats>      schedule: 0 6 * * *
  Purpose: safety net — find events past local midnight +3h with finalized observations but
           winning_bucket_idx IS NULL (missed in-line grading) ⇒ gradeEvent each; find events where
           Gamma shows resolved outcomePrices but we have no finalized observation ⇒ CRITICAL
           (truth pipeline is behind the market). LIVE RECONCILIATION branch (F-033; no-op in paper
           mode): fetch data-api /positions for the operator wallet, diff size/avgPrice/redeemable
           against live-mode bets ⇒ any drift CRITICAL POSITION_DRIFT.
  Called by: runJob. Calls: isLocalDayOver, gradeEvent, fetchJson, notifySlack, db.queries.bets.

dailyDigest(ctx): Promise<JobStats>          schedule: 0 7 * * *
  Purpose: Slack INFO digest: bankroll + Δ; yesterday's resolutions (city, winner, our q, market p,
           bet results); open recommendations count + total proposed stake; rolling 30d Brier
           house-vs-market table (top/bottom 5 cities); hit-rate-by-edge-decile mini-table (§11.4
           fidelity tracking); breaker states; job health one-liner; first digest of each month in
           live mode appends the withdrawal-discipline reminder (F-036).
  Called by: runJob. Calls: notifySlack, db.queries.{bets,calibration,jobs}.

healthMonitor(ctx): Promise<JobStats>        schedule: */30 * * * *
  Purpose: compare job_runs against the expected schedule matrix (each job's max staleness:
           poll-markets 15m, metar-nowcast 45m, fetch-actuals 2h, snapshots 14h, calibration 26h,
           discovery 10h — the real 17:10→02:10 gap is 9h; an 8h threshold would false-alarm nightly,
           W7) ⇒ CRITICAL JOB_STALE per breach (dedupe 6h; status='running' counts as fresh only
           while younger than the job's wall limit); REAPER: job_runs stuck 'running' past the wall
           limit → 'failed' + alert, period becomes retryable (ADR-12); ALERT RESEND: alerts_log
           rows sent=false older than 10 min → re-post (ADR-11); data-level checks: newest
           forecast_snapshot age > staleForecastHaltH OR newest market_snapshot age >
           stalePriceHaltMin ⇒ evaluateBreakers dead-man halt + CRITICAL; Open-Meteo model meta
           endpoints sampled for run availability anomalies (model stuck >24h ⇒ WARN);
           upcoming-events sanity: tomorrow's events exist for ≥80% of active cities else WARN.
  Called by: runJob. Calls: fetchJson, evaluateBreakers, notifySlack, db.queries.jobs.
```

### 6.20 `packages/trading` — executor boundary (ADR-10)

```
interface TradeExecutor {
  readonly mode: 'paper' | 'live'
  place(bet: ApprovedBet): Promise<FillResult>     // ApprovedBet = bets row + stored book/audit
  cancel(betId: string): Promise<void>             // live-phase: pulls a resting GTC order — reached ONLY
}                                                  // via execute-bet {action:'cancel'} (§6.20a); paper: no-op

PaperExecutor.place(bet): Promise<FillResult>   [executor.ts]
  Purpose: deterministic pessimistic fill: re-fetch the LIVE book for the token and fill at the
           WORSE of (walked stored ask, walked live ask) + cfg.paperSlippage — pessimism must
           survive fast repricing (W9; a 29-min-old price in a market that just moved on a METAR
           would be optimistic) → fee = takerFeeTotal(price, shares, feeRate) → re-evaluate risk
           caps against CURRENT open exposure (several stale recommendations approved together must
           not breach event/cluster/daily caps — W5) → the caps re-check AND the conditional CAS fill
           execute inside ONE Postgres RPC `fill_bet_with_caps(bet_id, price, shares)` guarded by
           pg_advisory_xact_lock(hashtext('bankroll')) — transaction-scoped in a single RPC, hence
           pool-safe. **The RPC re-derives exposure and re-applies the full cap ladder IN PLPGSQL
           from in-DB inputs only** (open bets, config, cities.region, ledger view; price/shares are
           parameters) — the TS applyRiskCaps is the sizing/display implementation and is
           parity-tested against the SQL (a TS-side check outside the lock would re-open the W17
           TOCTOU). Two concurrent approvals of DIFFERENT bets serialize and the second sees the
           first's exposure → on success: bets 'filled' (ADR-09), executed_price/fee/at, mode
           'paper'; bankroll_ledger entry type 'stake' (unique per bet).
  Error cases: stored book older than cfg.paperBookMaxAgeMin AND live book unavailable ⇒
               FillRejected('stale_book'); caps breached at fill time ⇒ FillRejected('caps');
               CAS miss (expired/approved concurrently) ⇒ FillRejected('bad_status').
  Called by: executeBet (§6.20a).
  Calls: fetchJson (live book), normalizeBook, executableAsk, takerFeeTotal,
         db.queries.bets (fill_bet_with_caps RPC — re-implements the exposure/cap ladder in plpgsql,
         parity-tested against exposureSummary + applyRiskCaps).

LiveExecutor.place(bet): Promise<FillResult>    [live.ts — DORMANT]
  Purpose: real order path, compiled + unit-tested against mocks from day one, constructible only
           when goLiveGate passes: ClobClient(host, chainId=137, signer from POLY_PRIVATE_KEY,
           creds via createOrDeriveApiKey) → tick-size & min-size re-fetched per market →
           createOrder({tokenID: tokenYes, price: bet.exec_ask (the recommendation's executable ask
           is the limit), size: shares, side: BUY}, { negRisk: true }) → postOrder GTC → poll order
           status → record fill or resting state.
           Phase A semantics: limit at recommendation's execAsk (taker-or-better); maker-resting
           strategy is a Phase-5 enhancement (§12).
  Error cases: clob-client errors mapped to ExecutionError{code}; any error ⇒ bet status
               'execution_failed' + CRITICAL alert; NEVER retries placement automatically (no
               accidental doubles — idempotency by client order id).
  Called by: executeBet (§6.20a) when mode='live'.
  Calls: @polymarket/clob-client, takerFeeTotal, db.queries.bets.

goLiveGate(db, cfg): Promise<{ pass: boolean; reasons: string[] }>   [gate.ts]
  Purpose: every condition for live mode, evaluated fresh on every live placement attempt:
           env POLY_PRIVATE_KEY present (execute-bet Edge secrets only — never web) ∧
           cfg.tradingMode='live' ∧ calibration gate, POOLED with significance (C5 fix — a 0.95×
           point threshold alone is passable by noise ≈30% of the time): ≥60 distinct out-of-sample
           days ∧ pooled time-matched per-event Brier difference vs market_consensus significant at
           p < 0.05 (paired bootstrap, persisted daily by runCalibration) ∧ pooled point estimate
           ≤ 0.95×; per-city betting additionally requires that city's own 60d estimate ≤ 1.0× with
           n ≥ 30 scored events (no enabling 5 lucky cities) ∧ no global/city halt ∧ geoblock
           re-check (fetch Polymarket geoblock list; Sweden absent) ∧ operator KYC/account-standing
           attestation refreshed this quarter (config row; spec §11.2) ∧ bankroll_ledger reconciled.
           Returns every failed reason — the dashboard shows the checklist verbatim.
  Called by: executeBet (§6.20a); getAdminState loader (§6.21 — gate READOUT only, see §8.3 boundary).
  Calls: fetchJson, db.queries.{calibration,bets,config}.
```

### 6.20a Edge Function `execute-bet` — the only process that executes (ADR-10)

```
executeBet(req): Promise<Response>   [supabase/functions/execute-bet/index.ts]
  Purpose: on-demand executor host (NOT cron-scheduled). Auth: requireCronAuth (x-cron-secret,
           supplied server-side by the web proxy — the browser never holds it).
           Body { betId, action?: 'place'|'cancel' (default 'place') }. place: load bet (must be
           'recommended', else 409) → cfg.tradingMode: 'live' ⇒ goLiveGate(); gate FAIL ⇒ 503 with
           reasons verbatim — NEVER a silent downgrade to a paper fill (C1) ⇒ else LiveExecutor;
           'paper' ⇒ PaperExecutor → place() → 200 FillResult, or 409/422 mapped from FillRejected.
           cancel (live phase): TradeExecutor.cancel pulls a resting GTC order — invoked by
           poll-markets' live-mode expiry via HTTP (the chokepoint stays intact).
           Synchronous (no waitUntil — the operator is waiting; worst case two API calls; the web
           proxy route exports maxDuration=90 to outlive retries).
  Called by: approveBet proxy (§6.21), adminManualBet (§6.21), pollMarkets live-mode expiry (§6.17, via HTTP).
  Calls: requireCronAuth, getServiceDb, goLiveGate, PaperExecutor.place, LiveExecutor.place,
         LiveExecutor.cancel (action='cancel').
```

### 6.21 `apps/web` — loaders, actions, components

Server loaders (RSC, anon-key + session, RLS-scoped):

```
getTodayOverview(): { bankroll, openRecs[], exposures (exposureSummary), pnlSeries, breakerStates, jobHealthSummary }
  Called by: app/page.tsx. Calls: db.queries.{bets,jobs,config}, exposureSummary.

getEventDetail(slug): { event, ladder, houseDist[], consensusDist[], nowcastFlag, edgeRows (recomputed
  display-side via computeBucketEdges for transparency), snapshotsSpark, bets[], runningMax }
  Called by: app/events/[slug]/page.tsx. Calls: db.queries.{markets,distributions,bets},
  computeBucketEdges (display), bucketRange.

getCityDetail(slug): { city, openEventToday (today's open event ladder + house/market overlay — the
  spec §12 "live market with our overlay", reusing DistributionOverlay), stationHistory
  (city_stations), calibrationHeatmap (model_stats matrix), brierTrend, betHistory, divergenceLog }
  Called by: app/city/[slug]/page.tsx. Calls: db.queries.{calibration,markets,bets,distributions}.

getCalibrationView(): { scoresBySource, reliabilityData, ecePanel, sharpness, championState, promotionCandidates }
  Called by: app/calibration/page.tsx. Calls: db.queries.calibration.

getBetsLedger(filters): { bets[], totals, equityCurve, hitRateByEdgeDecile }
  Called by: app/bets/page.tsx. Calls: db.queries.bets (equity curve from the ledger window-sum
  view — no stored running balance, §7.16/W10).

getSystemHealth(): { jobRuns matrix, alertsRecent, apiErrorRates, dataGaps, storageEstimate }
  Called by: app/system/page.tsx. Calls: db.queries.jobs.

getAdminState(): { config+audit, halts, unverifiedStations, goLiveChecklist (goLiveGate readout) }
  Called by: app/admin/page.tsx. Calls: db.queries.config, goLiveGate.
```

API route handlers (Node runtime, session-guarded + allow-listed email; mutating routes are
idempotent by current-state check):

```
approveBet(id): POST /api/bets/[id]/approve
  Purpose: session-checked THIN PROXY: server-side POST to /functions/v1/execute-bet with
           CRON_SECRET (ADR-10 — execution logic and the wallet key live only there); relays the
           function's response verbatim (200 fill / 409 / 422 / 503 gate reasons).
  Calls: executeBet (§6.20a via HTTP), db.queries.bets (fast 404 pre-check).
skipBet(id): POST /api/bets/[id]/skip          — conditional UPDATE WHERE status='recommended' →
  'skipped' + reason note (ADR-09).
adminHalt / adminResume: POST /api/admin/halt|resume   — scope {global|city|city_lead}; writes halt
  rows + config_audit; resume requires typed confirmation string; Slack CRITICAL on halt.
  Calls: notifySlack (via service), db.queries.config.
adminUpdateConfig: POST /api/admin/config      — zod-validate against ConfigSchema; diff →
  config_audit; bankroll/caps changes Slack WARN. Calls: parseConfigRows, notifySlack, db.queries.config.
adminVerifyStation: POST /api/admin/verify-station — sets city_stations.verified=true after operator
  confirms coordinates/ICAO against the live market description; re-enables betting_enabled.
adminTriggerJob: POST /api/admin/trigger-job   — server-side proxy POST to the Edge Function with
  CRON_SECRET (secret never reaches the browser); period key suffixed ':manual:{ts}'.
adminPromoteSource: POST /api/admin/promote-source — guard: candidate meets F-019 thresholds incl.
  bootstrap significance (server re-checks, not trusting the UI); updates championSource + audit.
  Calls: pairedBootstrapPValue, db.queries.calibration.
adminManualBet: POST /api/admin/manual-bet     — F-035: zod-validated {eventSlug, bucketLabel, side,
  shares, price, mode} → insert bets (status 'recommended', audit.manual=true) → paper: proxy to
  execute-bet for the standard fill path; live external fill: record executed_* verbatim.
  Calls: executeBet (§6.20a via HTTP), db.queries.bets.
adminExport: POST /api/admin/export            — streams CSV of bets + bankroll_ledger for a date
  range (K4/Skatteverket-ready: one row per fill and per resolution; R-16). Calls: db.queries.bets.
healthCheck: GET /api/health                   — 200 {db: ok, newestJobRun} for uptime monitoring
  (also the target of the external uptime pinger, R-18).
```

Components (§5 list) are presentational; `EdgeChart` renders per-bucket paired bars (house q vs market
ask) with pass/fail edge badges and reasons tooltip — the spec §12 "one screen tells you the whole
opportunity" view.

### 6.22 `scripts/*` — local CLIs (Node, direct Postgres via service role)

All backfills are resumable via `backfill_progress` (§7.20: script, scope, cursor, status) and
budget-aware via `requestWeight` (stay under free-tier caps; `--budget` flag, default 8000
weighted calls/day, persisted spend counter). Every script loads AppConfig via parseConfigRows
(scripts/lib) and uses packages/io for HTTP/Slack.

```
seedStations(): scripts/seed-stations.ts
  Purpose: download OurAirports airports.csv (cached locally) → upsert stations rows for every ICAO
           referenced by city_stations + the research-known set (lat, lon, name, country, tz via
           tz-lookup from coordinates; tz overridable per row); print unmatched ICAOs for manual entry.
  Calls: db.queries.markets (stations), fetchJson.

backfillForecasts(args { from?, to?, stations?, models? }): scripts/backfill-forecasts.ts
  Purpose: for each (station × model): previousRunsUrl over 14-day chunks from max(model archive
           start, --from default 2024-01-21; GFS/JMA optionally 2021) → parsePreviousRunsHourly →
           upsert forecast_snapshots (source 'backfill_prev_runs', snapshot_slot 'backfill') —
           full default run ≈ 49 stations × 8 models × ~60 chunks ≈ 24k weighted calls ⇒ ~3 days
           under the free budget (the budgeter sleeps & resumes; --budget raises it on paid tier).
  Calls: fetchJson, previousRunsUrl, parsePreviousRunsHourly, historicalForecastUrl,
         parseMultiModelDaily (pseudo-truth mode), requestWeight, localDayWindow, db.queries.forecasts.

backfillActuals(args { from?, to?, stations? }): scripts/backfill-actuals.ts
  Purpose: per station per local date in range: wuObsUrl → wuDailyMax → observations (finalized);
           on WU failure/sparse days: iemDailyUrl fallback (provenance 'iem_fallback', §7.7); °F cities pull
           units=e, others units=m; cross-fill metar replica where aviationweather archive reachable.
           FINAL PASS: build the initial nowcast_lift quantiles (§7.8a) per (station, local_hour)
           from the hourly observations gathered along the way (p50/p90 of final-max − running-max).
  Calls: fetchJson, wuObsUrl, parseWuObservations, wuDailyMax, iemDailyUrl, parseIemDaily,
         iemNetworkFor, localDayWindow, db.queries.observations.

backfillMarketHistory(args { from? }): scripts/backfill-market-history.ts
  Purpose: best-effort: Gamma closed events for tag 104596 (paginate closed=true) → parseGammaEvent →
           market_events/buckets (closed) + resolved winners from outcomePrices → per bucket token:
           CLOB prices-history (interval max) → synthesize market_snapshots at daily granularity +
           consensus distributions AT THE ADR-16 CUTOFFS (leads 0/1: the last price points at or
           before each cutoff timestamp — never post-cutoff prices, which embed the day's
           observations; events lacking pre-cutoff points are skipped for that lead and counted).
  Calls: fetchJson, parseGammaEvent, parseStringArray, impliedDistribution, db.queries.markets.

simulateHistoricalEdge(args { from, to, source }): scripts/simulate-historical-edge.ts
  Purpose: walk-forward replay over backfilled data: day by day, fit stats only on data before D
           (updateBias/fitSigma/computeModelWeights in-process) → build distributions for D at the
           ADR-16 cutoffs → score vs actuals (brierScore, time-matched against backfilled consensus
           rows at the same cutoffs) → where market history exists: computeBucketEdges vs
           consensus-as-price proxy + jointKellyStakes (fee-adjusted effective prices, as live) →
           simulated P&L → report: per-city/lead Brier
           house vs market, equity curve, drawdown, hit rates by edge decile → writes
           calibration_scores (window tag 'backtest') + CSV + console summary.
           Honest-fidelity note printed on every run: consensus-mid proxy ≠ executable book; results
           are indicative for GATING DIRECTION only, never a go-live justification by themselves.
  Calls: updateBias, fitSigma, computeModelWeights, correctPoint, toNative, gaussianBucketProbs,
         brierScore, computeBucketEdges, takerFeePerShare, jointKellyStakes, winningBucket, leadDays,
         localDayWindow (ADR-16 cutoffs), db read-only.

smokeLiveApis(): scripts/smoke-live-apis.ts
  Purpose: one live call per integration (Gamma tag page, CLOB book for a live token, Open-Meteo
           forecast+previous-runs+ensemble for RKSI, WU obs for KORD yesterday, aviationweather,
           IEM, Slack webhook test message) asserting zod schemas still match — run before every
           deploy and weekly via CI cron; failures list exactly which upstream changed shape.
  Calls: every parser in §6.9/6.10, fetchJson, slackPost (packages/io — test message).

backupDb(): scripts/backup-db.ts
  Purpose: pg_dump to ./backups/{date}.sql.gz (keeps last 8); the bets/bankroll_ledger/config_audit
           evidentiary core has no PITR on free tier (F-037, R-17); RUNBOOK schedules weekly.
  Calls: pg_dump via child_process, DATABASE_URL.
```

---

## 7. Data Models

Conventions: snake_case; every table has `created_at timestamptz default now()`; updatable tables add `updated_at` (trigger). Primary keys `uuid default gen_random_uuid()` unless a natural key is stated. All RLS-enabled (§11; policies in migration 0008). Temperatures: `_c` columns `numeric(5,2)`; `_native` columns `smallint` (WU integers). Money `numeric(12,2)`. Probabilities/prices `numeric(8,6)`.

### 7.1 `cities`
| Field | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| slug | text | unique, not null — Polymarket slug ('nyc') |
| display_name | text | not null |
| country_code | text(2) | not null |
| unit | text | not null, check in ('F','C') |
| tz | text | not null — IANA, from station |
| region | text | not null — cluster key (§6.8 clusterOf) |
| betting_enabled | boolean | not null default false |
| first_seen | timestamptz | not null |
| last_seen | timestamptz | not null |
| notes | text | |

Queries: by slug (discovery upsert); active list = `last_seen > now()-interval '7 days'` (all jobs).

### 7.2 `stations`
| Field | Type | Constraints |
|---|---|---|
| icao | text(4) | PK |
| name | text | |
| lat / lon | numeric(8,5) | not null — forecast query coords |
| elevation_m | numeric | |
| country_code | text(2) | not null |
| tz | text | not null |
| source | text | 'ourairports' \| 'manual' |

### 7.3 `city_stations` (temporal mapping — ADR-03)
| Field | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| city_id | uuid | FK cities, not null |
| icao | text | FK stations, not null |
| wu_country_code | text(2) | not null — the {CC} in WU location codes |
| valid_from | timestamptz | not null |
| valid_to | timestamptz | null = current |
| verified | boolean | not null default false |
| source_url | text | the resolutionSource it was parsed from |

Unique partial index: one current row per city (`city_id where valid_to is null`). Queries: current station per city (every job); station history (`/city` page).

### 7.4 `models`
| Field | Type | Constraints |
|---|---|---|
| slug | text | PK — Open-Meteo string ('ecmwf_ifs025') |
| display_name | text | |
| provider | text | |
| horizon_days | smallint | observed horizon |
| archive_start | date | Previous-Runs archive start |
| enabled | boolean | default true |
| is_ensemble | boolean | default false |

Seed (migration 0010): ecmwf_ifs025, gfs_seamless, icon_seamless, jma_seamless, gem_seamless, meteofrance_seamless, ukmo_seamless, cma_grapes_global, best_match (+ ensemble rows ecmwf_ifs025_ens, gfs05_ens). KMA/ecmwf_ifs04/gfs025 seeded `enabled=false` with notes (verified dead).

### 7.5 `forecast_snapshots`
| Field | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| icao | text | FK stations, not null |
| model | text | FK models, not null |
| target_date | date | not null — station-local |
| lead_days | smallint | not null, check 0..16 |
| tmax_c | numeric(5,2) | not null |
| snapshot_slot | text | not null — '10Z'\|'22Z'\|'backfill'\|'gapfill' |
| source | text | not null — 'forecast_api'\|'previous_runs'\|'backfill_prev_runs' |
| captured_at | timestamptz | not null |

Unique (icao, model, target_date, lead_days, snapshot_slot). Indexes: (icao, target_date), (model, target_date), (target_date, lead_days). Queries: latest set per (station, target) for §6.16; residual join in §6.18; matrix gap-detect in §6.14.
**Honest storage math (C3 — recomputed with index overhead ≈ 290 B/row incl. PK + 5-col unique + 3 secondary):** forward ingest = ~9 models × 50 × 16 targets × 2 slots ≈ 14k rows/day ≈ **4 MB/day ≈ 120 MB/month unbounded** — forward ingest alone would blow the free tier in ~4 months, independent of backfill. **Retention rule (enforced by the downsample cron):** rows older than 90 days keep only leads 0–2 at slot 10Z (the calibration-relevant history, ~85% reduction). Backfill defaults (leads 1–7, 5 high-liquidity models, from 2024-01-21 ≈ 1.6M rows) ≈ **300–460 MB with indexes**, not 130 MB. Conclusion: **Supabase Pro ($25/mo, 8 GB) is budgeted from P4 onward** (R-4); free tier carries P0–P3 only.

### 7.6 `ensemble_snapshots`
| id uuid PK · icao FK · model text FK · target_date date · lead_days smallint · snapshot_slot text · members_c numeric(5,2)[] not null · n_members smallint · captured_at timestamptz |
Unique (icao, model, target_date, snapshot_slot). Member arrays (~51 numerics) keep row counts ~10× lower than per-member rows.

### 7.7 `observations`
| Field | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| icao | text | FK stations, not null |
| date_local | date | not null |
| tmax_wu_native | smallint | null until fetched — THE grading value |
| unit | text | check in ('F','C'), not null |
| n_obs | smallint | WU observation count |
| tmax_metar_tenths_c | numeric(4,1) | METAR replica max |
| tmax_metar_native | smallint | metarMaxToNative result |
| tmax_iem_f | numeric(4,1) | IEM second opinion |
| tmax_era5_c | numeric(4,1) | gridded sanity |
| provenance | text | 'wu' \| 'iem_fallback' |
| provisional | boolean | not null default true |
| finalized_at | timestamptz | null until next-day datapoint confirmed |
| divergence_flags | text[] | e.g. {'metar+1','iem-2'} |

Unique (icao, date_local). Queries: unfinalized scan (§6.15); residual join (§6.18); city history page.

### 7.8 `intraday_max`
| icao text · date_local date · max_tenths_c numeric(4,1) · max_native smallint · n_obs smallint · last_obs_at timestamptz · updated_at |
PK (icao, date_local). Written by metar-nowcast; read by §6.16 nowcast + dashboard badge. Pruned > 14 days.

### 7.8a `nowcast_lift` (ADR-15's "remaining lift" table)
| icao text · local_hour smallint (0–23) · p50_remaining numeric(4,1) · p90_remaining numeric(4,1) — °C still to come over the rest of the local day, empirical quantiles · n int · updated_at |
PK (icao, local_hour). Built initially by backfill-actuals from hourly WU/METAR history; refreshed weekly by run-calibration step (7). Read by buildDistributionForEvent's nowcast path (§6.16) via the `lift` param of applyRunningMaxConstraint (§6.5). Missing row ⇒ truncation-only (constraint still applies, just unsharpened).

### 7.9 `market_events`
| Field | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| poly_event_id | text | unique, not null |
| slug | text | unique, not null |
| kind | text | not null default 'highest', check in ('highest','lowest') |
| city_id | uuid | FK cities, not null |
| icao_at_creation | text | parsed station; FK stations |
| target_date | date | not null (station-local) |
| unit | text | not null |
| neg_risk_market_id | text | |
| accepting_orders | boolean | |
| volume24h | numeric(14,2) | refreshed by poll |
| liquidity | numeric(14,2) | |
| ladder_ok | boolean | not null — validateLadder verdict |
| ladder_problems | text[] | |
| winning_bucket_idx | smallint | null until graded |
| poly_resolved_winner_idx | smallint | from outcomePrices when closed |
| grading_mismatch | boolean | default false — CRITICAL flag |
| resolved_at | timestamptz | |
| closed | boolean | default false |
| first_seen / last_seen | timestamptz | |

Unique (city_id, target_date, kind). Queries: open events (poll, distributions); by slug (event page); ungraded sweep (§6.19).

### 7.10 `market_buckets`
| Field | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| event_id | uuid | FK market_events, not null |
| bucket_idx | smallint | not null — ladder position 0..n−1 |
| label | text | not null |
| low_native / high_native | smallint | null = open tail |
| poly_market_id | text | unique |
| condition_id | text | not null |
| token_yes / token_no | text | not null — 77-digit decimal strings |
| tick_size | numeric(6,4) | per-bucket (0.01 / 0.001 verified) |
| min_order_size | numeric(8,2) | |
| fee_rate | numeric(5,4) | from feeSchedule.rate |
| resolved_outcome | text | 'win'\|'lose'\|null |

Unique (event_id, bucket_idx). Queries: ladder load (everything); token lookup (books, history backfill).

### 7.11 `market_snapshots` (delta-deduped)
| id uuid PK · bucket_id uuid FK · best_bid numeric(8,6) · best_ask numeric(8,6) · mid numeric(8,6) · spread numeric(8,6) · last_trade numeric(8,6) · book_top3 jsonb null — {bids:[{p,s}×3], asks:[…]} when fetched · captured_at timestamptz |
**Unique (bucket_id, captured_at)** — backstop against double-inserts; the real overlap guard is poll-markets' job_locks lease (ADR-12/C8). Index (bucket_id, captured_at desc). Write rule (§6.17): only on |Δmid| ≥ 0.005 or heartbeat — **heartbeat 30 min for candidate events (lead ≤ 2, acceptingOrders), 2 h otherwise** (C3: a flat 30-min heartbeat over ~1,500 open buckets is 72k rows/day ≈ 15–20 MB/day with indexes — unacceptable). Retention: rows > 7 days downsampled to hourly; > 30 days to 4/day; > 180 days to 1/day (pg_cron `0 3 * * *`). Steady state ≈ 30–60 MB under these rules; Pro tier from P4 regardless (§7.5).

### 7.12 `bucket_probabilities`
| id uuid PK · event_id uuid FK · source text not null ('house_gaussian'\|'house_ensemble'\|'market_consensus'+) · lead_days smallint · nowcast boolean default false · made_at timestamptz not null · inputs_hash text not null · probs numeric(8,6)[] not null — aligned to bucket_idx · mu_native numeric(6,2) · sigma_native numeric(5,2) · stats_version int · **scored_for_leads smallint[] not null default '{}' — gradeEvent appends each lead this row is the ADR-16 cutoff row for (one quiet-market row can carry both leads — W18)** · brier numeric(8,6) — filled at grading |
Unique (event_id, source, inputs_hash). Array storage (one row per distribution, not per bucket) cuts row count 11×; §6.12 grading and §6.21 loaders index probs by bucket_idx. **Retention (C3):** consensus hashes change on every price move, so 30 days after an event resolves, delete all its rows EXCEPT scored rows (`scored_for_leads <> '{}'`), the final row per source, and nowcast extrema.

### 7.13 `model_stats`
| icao text · model text · lead_days smallint · **snapshot_slot text ('10Z'\|'22Z')** · bias_c numeric(5,2) · residual_sigma_c numeric(5,2) · n_residuals int · mse numeric(8,4) · weight numeric(6,5) · stats_version int · window_days smallint · updated_at |
PK (icao, model, lead_days, snapshot_slot) — 10Z and 22Z snapshots at the same lead carry 12 h different information age and are never pooled (W3: pooling makes morning-built distributions overconfident and evening-built ones underconfident, with sign varying by station longitude). History preserved in `model_stats_history` (same shape + version PK) for audit/replay.

### 7.14 `calibration_scores`
| city_id uuid · source text · lead_days smallint · window_tag text check in ('30d','60d','90d','backtest','nowcast') · brier numeric(8,6) · brier_market numeric(8,6) · bootstrap_p numeric(8,6) null — pooled rows only · ece numeric(8,6) · sharpness numeric(8,6) · reliability jsonb · n_events int · updated_at |
PK (city_id, source, lead_days, window_tag). A reserved all-cities row (city_id = the zero UUID) holds the POOLED 60d statistics incl. `bootstrap_p` that goLiveGate reads.

### 7.15 `bets`
| Field | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| event_id / bucket_id | uuid | FK, not null |
| side | text | check in ('YES','NO'), default 'YES' |
| status | text | check in ('recommended','expired','skipped','filled','execution_failed','resolved_win','resolved_lose'), not null |
| mode | text | check in ('paper','live'), not null default 'paper' |
| our_q | numeric(8,6) | not null |
| best_ask / exec_ask | numeric(8,6) | not null |
| edge / min_edge | numeric(8,6) | not null |
| fee_per_share | numeric(8,6) | not null |
| kelly_raw / kelly_frac / capped_frac | numeric(8,6) | not null |
| rec_stake_usd | numeric(10,2) | not null |
| rec_shares | numeric(12,2) | not null |
| audit | jsonb | not null — full input vector (ADR-09) |
| dist_row_id | uuid | FK bucket_probabilities |
| recommended_at / expires_reason | timestamptz / text | |
| approved_at | timestamptz | |
| executed_price / executed_fee / executed_size_usd / executed_shares | numerics | null until filled |
| executed_at | timestamptz | |
| pnl_usd | numeric(10,2) | null until resolved |
| resolution_native | smallint | actual temp at grading |
| notes | text | |

Partial unique: one open ('recommended') row per (bucket_id, side). Queries: open recs (dashboard, poll refresh); open exposure (risk ctx); ledger filters; consecutive-loss streaks per (city, lead).

### 7.15a `edge_decile_stats` (VIEW — no storage)
Read-time aggregate over resolved bets: `decile = width_bucket(edge, 0, 0.5, 10)`; per (decile, mode): n, hit_rate, avg_edge, avg_q, pnl_sum. Consumed by dailyDigest (§6.19) and getBetsLedger (§6.21) — the adverse-selection tracker named in §11.4/R-13.

### 7.16 `bankroll_ledger`
| id uuid PK · bet_id uuid FK null · entry_type text check in ('init','stake','payout','fee_adjust','withdrawal','manual') · amount_usd numeric(12,2) · mode text ('paper'\|'live') · created_at |
Unique (bet_id, entry_type) where bet_id not null (refund/double-grade impossible — per-mutation idempotency). **No stored running balance** (W10: concurrent gradeEvent calls would read-modify-write-corrupt it); balances and equity curves come from the `bankroll_balance` VIEW (window SUM ordered by created_at, id). Seeded with init $1,000 paper.

### 7.17 `job_runs`
| id uuid PK · job text · period_key text · status text check in ('running','ok','failed') · attempt int not null default 1 · stats jsonb · error text · started_at · finished_at · duration_ms int |
Unique (job, period_key) — the idempotency backbone (ADR-12); takeover bumps `attempt` via CAS on the same row (W16). Retention: 90 days.

### 7.17a `job_locks` (C8)
| job text PK · holder text · expires_at timestamptz not null |
Lease rows claimed by single CAS UPDATE (`SET holder=$run, expires_at=now()+wall WHERE expires_at < now() RETURNING`) — pool-safe over PostgREST where session-scoped pg advisory locks are not; auto-expires on isolate death. v1 rows: 'poll-markets'. Seeded in migration 0007.

### 7.18 `alerts_log`
| id uuid PK · kind text · severity text · dedupe_key text · title text · body text · sent boolean · created_at |
Unique (dedupe_key, date(created_at)) where dedupe_key not null.

### 7.19 `config` + `config_audit`
config: | key text PK · value text · updated_at |. config_audit: | id PK · key · old_value · new_value · actor text ('admin-ui'\|'system') · created_at |. Halts live here as keys `halt:global`, `halt:city:{slug}`, `halt:city_lead:{slug}:{lead}` with reason JSON values.

### 7.20 `backfill_progress`
| script text · scope text (station/model) · cursor date · status text · weighted_calls_used numeric · updated_at | PK (script, scope).

### 7.21 `edge_evaluations` (F-038)
| id uuid PK · event_id uuid FK · bucket_idx smallint · captured_hour timestamptz (hour-truncated) · q numeric(8,6) · exec_ask numeric(8,6) · edge numeric(8,6) · min_edge numeric(8,6) · pass boolean · reasons text[] |
Unique (event_id, bucket_idx, captured_hour). Written hourly by poll-markets step 8; retention 30 days (downsample cron). This is what makes "why didn't we bet on yesterday's winner" answerable from stored data (W14).

### Relationships summary
cities 1:N city_stations N:1 stations · cities 1:N market_events 1:N market_buckets 1:N market_snapshots · market_events 1:N bucket_probabilities / edge_evaluations · stations 1:N forecast_snapshots / ensemble_snapshots / observations / intraday_max · (icao, model, lead, slot) 1:1 model_stats · market_events+buckets 1:N bets N:1 bucket_probabilities · bets 1:N bankroll_ledger.

### 7.22 pg_cron registrations (migration 0009)
| job | cron (UTC) | invokes |
|---|---|---|
| discover-markets | `10 2,4,5,11,17 * * *` | functions/v1/discover-markets |
| snapshot-forecasts | `15 10,22 * * *` | …/snapshot-forecasts |
| snapshot-ensembles | `35 10,22 * * *` | …/snapshot-ensembles |
| build-distributions | `50 10,22 * * *` | …/build-distributions |
| poll-markets | `*/5 * * * *` | …/poll-markets |
| metar-nowcast | `*/15 * * * *` | …/metar-nowcast |
| fetch-actuals | `20 * * * *` | …/fetch-actuals |
| run-calibration | `30 11 * * *` | …/run-calibration |
| grade-bets | `0 6 * * *` | …/grade-bets |
| daily-digest | `0 7 * * *` | …/daily-digest |
| health-monitor | `*/30 * * * *` | …/health-monitor |
| snapshot-downsample (SQL-only) | `0 3 * * *` | in-database delete/downsample (§7.11) |

Each registration: `select net.http_post(url, headers => jsonb_build_object('x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')), timeout_milliseconds => 4500)` — **the secret lives in Supabase Vault, seeded manually per RUNBOOK; it never appears in committed SQL or readable cron.job rows (W11)**. Fire-and-forget against runJob's 202 (ADR-02, ADR-12). `execute-bet` is deliberately NOT registered — invoked on demand via the web proxy only (ADR-10). The snapshot-downsample job also enforces every retention rule in §7.5 / §7.8 / §7.11 / §7.12 / §7.21 and the 90-day job_runs/alerts_log prune.

---

## 8. Interface Contracts

### 8.1 Job endpoints (Supabase Edge Functions)

All job endpoints share one contract shape (implemented by `runJob`, §6.12):

```
[POST] /functions/v1/{job-name}
  Purpose: trigger one job run for a period
  Auth: header x-cron-secret == env CRON_SECRET (pg_cron and the admin proxy are the only callers)
  Request:
    Headers: { x-cron-secret: String, content-type: application/json }
    Body: { periodKey?: String }   // omitted ⇒ derived from current time slot
  Response:
    202: { accepted: true, job: String, periodKey: String }
    401: { error: 'ERR_CRON_AUTH' }
    409: { error: 'ERR_ALREADY_RAN', periodKey: String }
  Maps to: runJob (§6.12) wrapping the job handler
```

Instances (handler in parentheses): `[POST] /functions/v1/discover-markets` (discoverMarkets §6.13) · `[POST] /functions/v1/snapshot-forecasts` (snapshotForecasts §6.14) · `[POST] /functions/v1/snapshot-ensembles` (snapshotEnsembles §6.14) · `[POST] /functions/v1/fetch-actuals` (fetchActuals §6.15) · `[POST] /functions/v1/metar-nowcast` (metarNowcast §6.15) · `[POST] /functions/v1/build-distributions` (buildDistributions §6.16) · `[POST] /functions/v1/poll-markets` (pollMarkets §6.17) · `[POST] /functions/v1/run-calibration` (runCalibration §6.18) · `[POST] /functions/v1/grade-bets` (gradeBetsSweep §6.19) · `[POST] /functions/v1/daily-digest` (dailyDigest §6.19) · `[POST] /functions/v1/health-monitor` (healthMonitor §6.19).

The executor endpoint shares the auth header but NOT the runJob wrapper — synchronous, unscheduled:

```
[POST] /functions/v1/execute-bet
  Purpose: execute one approved recommendation (paper fill, or gated live order)
  Auth: header x-cron-secret == env CRON_SECRET (supplied server-side by the web proxy — never a browser)
  Request:
    Body: { betId: String, action: 'place'|'cancel' }   // action defaults to 'place'; 'cancel' is live-phase only
  Response:
    200: { fill: { price: Number, shares: Number, feeUsd: Number, mode: 'paper'|'live' } }
    401: { error: 'ERR_CRON_AUTH' }
    404: { error: 'ERR_NOT_FOUND' }
    409: { error: 'ERR_BAD_STATUS', status: String }
    422: { error: 'ERR_STALE_BOOK' | 'ERR_CAPS', details: [String] }
    503: { error: 'ERR_GATE_FAILED', reasons: [String] }   // live mode only — NEVER paper-fills instead
  Maps to: executeBet (§6.20a)
```

### 8.2 Operator API (Next.js routes; session auth = Supabase cookie + allow-listed email)

```
[POST] /api/bets/{id}/approve
  Purpose: thin authenticated proxy — relays to the execute-bet Edge Function (ADR-10) and returns
           its response verbatim
  Auth: session, operator email
  Request: Body: { } (id in path)
  Response:
    200: { fill: { price: Number, shares: Number, feeUsd: Number, mode: 'paper'|'live' } }
    401: { error: 'ERR_AUTH' }
    404: { error: 'ERR_NOT_FOUND' }
    409: { error: 'ERR_BAD_STATUS', status: String }      // not 'recommended' anymore (raced expiry)
    422: { error: 'ERR_STALE_BOOK' | 'ERR_CAPS' }          // FillRejected, relayed
    503: { error: 'ERR_GATE_FAILED', reasons: [String] }   // live mode, gate failing — no paper fallback
  Maps to: approveBet (§6.21) → [POST] /functions/v1/execute-bet (§6.20a)

[POST] /api/bets/{id}/skip
  Purpose: dismiss a recommendation with a reason
  Auth: session
  Request: Body: { reason: String }
  Response:
    200: { ok: true }
    404: { error: 'ERR_NOT_FOUND' }
    409: { error: 'ERR_BAD_STATUS' }
  Maps to: skipBet (§6.21)

[POST] /api/admin/halt
  Purpose: halt betting at a scope
  Auth: session
  Request: Body: { scope: 'global'|'city'|'city_lead', city?: String, lead?: Number, reason: String }
  Response:
    200: { ok: true, haltKey: String }
    400: { error: 'ERR_VALIDATION', details: [...] }
  Maps to: adminHalt (§6.21)

[POST] /api/admin/resume
  Purpose: lift a halt (typed confirmation)
  Auth: session
  Request: Body: { haltKey: String, confirm: String }   // confirm must equal haltKey
  Response:
    200: { ok: true }
    400: { error: 'ERR_CONFIRM_MISMATCH' }
    404: { error: 'ERR_NOT_FOUND' }
  Maps to: adminResume (§6.21)

[POST] /api/admin/config
  Purpose: update tunables with audit
  Auth: session
  Request: Body: { changes: { key: String, value: String }[] }
  Response:
    200: { ok: true, applied: Number }
    400: { error: 'ERR_VALIDATION', details: [{ key, message }] }
  Maps to: adminUpdateConfig (§6.21) → parseConfigRows (§6.11)

[POST] /api/admin/verify-station
  Purpose: operator confirms a station mapping; re-enables betting for the city
  Auth: session
  Request: Body: { cityStationId: String }
  Response:
    200: { ok: true }
    404: { error: 'ERR_NOT_FOUND' }
    409: { error: 'ERR_NOT_CURRENT' }     // row already superseded
  Maps to: adminVerifyStation (§6.21)

[POST] /api/admin/trigger-job
  Purpose: manual job run (server-side proxy adds CRON_SECRET)
  Auth: session
  Request: Body: { job: String }
  Response:
    200: { accepted: true, periodKey: String }
    400: { error: 'ERR_UNKNOWN_JOB' }
    502: { error: 'ERR_JOB_UNREACHABLE' }
  Maps to: adminTriggerJob (§6.21) → [POST] /functions/v1/{job}

[POST] /api/admin/promote-source
  Purpose: promote a challenger distribution source to champion (F-019 thresholds re-checked server-side)
  Auth: session
  Request: Body: { source: String }
  Response:
    200: { ok: true, champion: String }
    409: { error: 'ERR_GATE_FAILED', reasons: [String] }
  Maps to: adminPromoteSource (§6.21)

[POST] /api/admin/manual-bet
  Purpose: record an operator-placed bet through the standard schema + fill path (F-035)
  Auth: session
  Request: Body: { eventSlug: String, bucketLabel: String, side: 'YES'|'NO', shares: Number,
                   price?: Number, mode: 'paper'|'live', executedExternally?: Boolean }
  Response:
    200: { betId: String, fill?: Object }
    400: { error: 'ERR_VALIDATION', details: [...] }
    404: { error: 'ERR_NOT_FOUND' }              // unknown event/bucket
  Maps to: adminManualBet (§6.21) → executeBet (§6.20a) for the fill path

[POST] /api/admin/export
  Purpose: K4/Skatteverket-ready CSV of fills + resolutions for a date range (R-16)
  Auth: session
  Request: Body: { from: String, to: String, mode?: 'paper'|'live' }
  Response:
    200: text/csv stream
    400: { error: 'ERR_VALIDATION' }
  Maps to: adminExport (§6.21)

[GET] /api/health
  Purpose: uptime probe (target of the external out-of-band pinger, R-18)
  Auth: none
  Response:
    200: { db: 'ok', newestJobRun: String }
    503: { db: 'down' }
  Maps to: healthCheck (§6.21)
```

### 8.3 Internal module contracts

```
TradeExecutor (packages/trading/executor.ts — ADR-10)
  Inputs: ApprovedBet (bets row + stored book + config)
  Outputs: FillResult { price, shares, feeUsd, mode } | FillRejected { code }
  Implementations: PaperExecutor (default), LiveExecutor (gated by goLiveGate)
  Maps to: executeBet (§6.20a) → PaperExecutor.place / LiveExecutor.place (§6.20)
  Invariant (review- and lint-enforced): no module outside packages/trading imports
  @polymarket/clob-client; the EXECUTORS (executor.ts, live.ts) are imported only by the execute-bet
  function; apps/web may import packages/trading/gate.ts ONLY (goLiveGate readout — gate.ts has no
  clob-client in its import graph; ESLint boundary rule); POLY_PRIVATE_KEY exists only in
  execute-bet's function secrets.

DistributionMethod registry (core/distributions — ADR-06)
  Inputs: { event ladder, forecast set, model_stats, intraday max? }
  Outputs: probs: number[] (Σ=1±1e-9, aligned to bucket_idx)
  Implementations: house_gaussian, house_ensemble, market_consensus (+future entries, §12)
  Maps to: buildDistributionForEvent (§6.16)
  Invariant: every source is scored identically by runCalibration; betting reads only config.championSource.

TruthSource hierarchy (ADR-05)
  Canonical: WU v1 hourly max (grading) → independent: METAR replica → secondary: IEM → sanity: ERA5T
  Maps to: fetchActuals (§6.15), gradeEvent (§6.12)
  Invariant: gradeEvent reads ONLY observations.tmax_wu_native (provenance 'wu'); fallback provenance
  'iem_fallback' rows never grade bets — they hold history for calibration only and the event stays
  ungraded pending WU (sweep escalates CRITICAL after 48h).
```

---

## 9. Data Flow Diagrams

**9.1 Daily forecast capture (happy path)**
```
pg_cron 10:15Z → [POST] /functions/v1/snapshot-forecasts → runJob(202, waitUntil)
  → for station: forecastUrl → fetchJson(api.open-meteo.com) → parseMultiModelDaily
  → leadDays per row → upsert forecast_snapshots (slot '10Z')
  → gap matrix check → (holes? previousRunsUrl → parsePreviousRunsHourly → upsert 'gapfill')
  → job_runs ok
Error branch: station fetch fails ×2 retries → skip station, stats.failed++ → >20% failed
  → notifySlack(WARN) ; job_runs ok-with-stats. Total failure → job_runs failed → Slack CRITICAL.
```

**9.2 Market discovery & station change**
```
pg_cron 05:10Z → discover-markets → fetchJson(gamma events?tag_id=104596…, paginate to short page)
  → isZombieEvent filter → parseGammaEvent
  → city upsert (new ⇒ Slack WARN + betting_enabled=false)
  → extractStationFromUrl vs current city_stations
      same → touch cities.last_seen
      different → close old row; insert {verified:false}; cities.betting_enabled=false;
                  Slack CRITICAL STATION_CHANGE → (operator: /admin → [POST] /api/admin/verify-station)
  → upsert market_events + market_buckets
  → buildDistributionForEvent for each NEW event (ADR-16 row-existence guarantee) → job_runs ok
Error branch: parseGammaEvent throws (label change) → event stored ladder_ok=false +
  Slack WARN PARSE_FAIL; engine skips unbettable events.
```

**9.3 Truth & grading**
```
pg_cron hourly :20 → fetch-actuals → stations with isLocalDayOver(unfinalized dates)
  → wuObsUrl(units per city) → parseWuObservations → wuDailyMax → upsert observations(provisional)
  → next-day probe → isFinalized?
      yes → finalized_at set → divergence checks (METAR replica, IEM) → flags/WARNs
          → for each event(city,date): gradeEvent
              → winningBucket(actual) → market_events.winning_bucket_idx
              → bets: resolved_win/lose + pnl(net fees) → bankroll_ledger (unique per bet)
              → vs Polymarket outcomePrices → mismatch? Slack CRITICAL + grading_mismatch
              → brierScore per source → bucket_probabilities.brier
              → evaluateBreakers(streaks) → halts → Slack
      no → retry next hour
Error branch: WU 401 → extractWuApiKey(refetched page) → retry; still failing → CRITICAL WU_KEY,
  METAR provisional shown on dashboard, grading deferred (TruthSource invariant §8.3).
```

**9.4 Edge → recommendation → paper fill**
```
pg_cron */5 → poll-markets → gamma tag query → market_snapshots (delta-deduped)
  → impliedDistribution → bucket_probabilities('market_consensus')
  → bettable events → champion dist (fresh?) → screen → CLOB /book → normalizeBook
  → computeBucketEdges → applyLiquidityFilters → jointKellyStakes → applyKellyFraction
  → exposureSummary → applyRiskCaps → bets('recommended', audit) → Slack ACTION BET_REC
Operator: Slack link → /events/[slug] (getEventDetail: overlay, Kelly math, reasons)
  → [POST] /api/bets/{id}/approve (proxy) → [POST] /functions/v1/execute-bet → executeBet
      → PaperExecutor.place: live-book re-walk → fill at worse-of(stored, live) + slippage + fee
      → caps re-check vs current exposure → CAS 'recommended'→'filled' + ledger 'stake'
Error branches: edge decayed → next poll CAS-expires + Slack INFO; approval racing expiry →
  exactly one CAS winner, loser gets 409. Book >5 min stale AND live book unreachable → 422
  ERR_STALE_BOOK. Caps breached at fill time (stale recs approved together) → 422 ERR_CAPS.
  Live mode with failing gate → 503 verbatim reasons (never a silent paper fallback).
```

**9.5 Calibration & champion governance**
```
pg_cron 11:30Z → run-calibration → residuals(join snapshots×observations)
  → updateBias/fitSigma/computeModelWeights → model_stats (version++)
  → brier/ECE/reliability/sharpness per (city, lead, source, window) → calibration_scores
  → gates: city Brier>0.30 → halt city; house≥market on 30d+60d → halt all + CALIB_DRIFT
  → challenger >5% better 60d → Slack ACTION promotion suggestion
      → operator /admin → [POST] /api/admin/promote-source (server re-checks F-019) → champion swap + audit
  → buildDistributions (fresh stats)
```

**9.6 Intraday nowcast**
```
pg_cron */15 → metar-nowcast → aviationweather batch(ids=daytime stations)
  → parseMetarJson → metarRunningMax → intraday_max upsert (advanced?)
  → buildDistributionForEvent(target-day events; applyRunningMaxConstraint; nowcast=true)
  → next poll-markets cycle prices the constrained distribution
Error branch: aviationweather down → stale intraday_max; §6.16 still constrains at last known max
  (conservative); healthMonitor alerts at 45-min staleness.
```

**9.7 Backfill & historical simulation (local, one-off)**
```
operator: pnpm seed-stations → pnpm backfill-forecasts (budgeted chunks, resumable)
        → pnpm backfill-actuals → pnpm backfill-market-history (best-effort)
        → pnpm simulate-historical-edge --from 2024-02-03
            → walk-forward fit (no peeking) → daily distributions → Brier vs consensus
            → simulated P&L report + calibration_scores(window 'backtest')
Output consumed in: /calibration page (backtest tab) + go-live evidence pack.
```

**9.8 Health & dead-man**
```
pg_cron */30 → health-monitor → job_runs vs staleness matrix → JOB_STALE CRITICALs (deduped)
  → data freshness: forecasts >30h or prices >30min → evaluateBreakers → halt:global('dead_man')
  → Slack CRITICAL → operator /system → fix → [POST] /api/admin/trigger-job → [POST] /api/admin/resume
```

**9.9 Go-live (future, gated)**
```
operator completes docs/GO-LIVE-CHECKLIST.md → funds wallet → sets POLY_PRIVATE_KEY (Edge secrets only)
  → /admin shows goLiveGate checklist green (60d evidence + bootstrap significance, geoblock
    re-check, KYC attestation, reconciled ledger)
  → config.tradingMode='live' (audited) → next approve → execute-bet → goLiveGate →
    LiveExecutor.place (GTC at exec_ask, negRisk:true)
  → fill recorded mode='live' → nightly reconciliation vs data-api /positions (F-033, in grade-bets)
```

**9.10 Morning review (J-1)**
```
pg_cron 07:00Z → daily-digest → Slack INFO (bankroll, resolutions, Brier table, edge-decile table,
  breaker states, job health)
  → operator opens / (getTodayOverview) → BetCard approve/skip per 9.4 → /system spot-check
  → anomalies route into J-4 via the 9.8 paths
```

---

## 10. Dependency Map

### 10.1 Internal (module → depends on)

```
core/time, core/units, core/errors, core/config   → (leaf modules)
packages/io (fetchJson, slackPost)                → (leaf — fetch + webhook only, no DB; shared by
                                                    functions/_shared, packages/trading, scripts)
core/buckets                                      → (leaf)
core/fees                                         → (leaf)
core/distributions/gaussian|ensemble|consensus    → core/buckets
core/distributions/nowcast                        → core/buckets
core/calibration/emos|scores                      → (leaf)
core/edge                                         → core/fees
core/kelly, core/risk                             → (leaf)
core/polymarket/gamma                             → core/buckets, core/time
core/polymarket/clob                              → (leaf)
core/weather/openmeteo|metar                      → core/time
core/weather/wu|iem                               → (leaf)
packages/db                                       → core (types only)
packages/trading                                  → core/edge, core/fees, core/risk, packages/io,
                                                    packages/db, @polymarket/clob-client
functions/_shared                                 → core/config, core/errors, core/buckets, core/fees,
                                                    core/calibration, core/risk, core/time (gradeEvent),
                                                    packages/io, packages/db
functions/* (11 scheduled jobs)                   → functions/_shared, core/*, packages/db
functions/execute-bet                             → packages/trading, functions/_shared
apps/web loaders/routes                           → packages/db, core (display math),
                                                    packages/trading/gate.ts ONLY (goLiveGate readout —
                                                    execution always via the execute-bet HTTP proxy)
scripts/*                                         → core/*, packages/io, packages/db
```

No cycles: core/io ← db ← {trading, functions, web, scripts}; trading never imports functions or web; clob-client reaches runtime only inside execute-bet (ADR-10/§8.3).

### 10.2 External packages/services

| Dependency | Pinned | Used by | Failure posture |
|---|---|---|---|
| @supabase/supabase-js | ^2.x | db, web, functions | system-down: jobs fail loudly via pg_cron next tick |
| @polymarket/clob-client | ^5.8.1 | packages/trading only | dormant until live phase |
| zod | ^3.x | core, web | — |
| date-fns + @date-fns/tz | ^4 / ^1 | core/time | — |
| next / react / tailwind / shadcn / recharts | 15.x / 19 / 3 / — / 2 | web | dashboard-only outage, pipelines unaffected |
| vitest, playwright, tsx | dev | tests/scripts | — |
| Gamma / CLOB / data-api | live services | jobs, scripts | retry + WARN/CRITICAL ladder (§11.1) |
| Open-Meteo (4 hosts) | live | jobs, scripts | gap-fill via Previous Runs recovers ≤7 days |
| api.weather.com (WU) | live, unofficial | fetch-actuals, backfill | key rotation handler + IEM/METAR fallback + CRITICAL |
| aviationweather.gov / IEM | live | nowcast, cross-checks | degrade-to-stale, alert |
| Slack webhook | live | notifier | log-and-continue (never blocks pipelines) |

---

## 11. Cross-Cutting Concerns

### 11.1 Error Taxonomy (`core/errors.ts`)

```
AppError (base: { code, message, details? })
├── ConfigError            — invalid config rows; fail-fast at job start
├── ValidationError (400)  — bad operator API input
├── AuthError (401)        — session/cron-secret failures
├── NotFoundError (404)
├── ConflictError (409)    — idempotency (ERR_ALREADY_RAN, ERR_BAD_STATUS)
├── UpstreamError (502)    — { source, status, retryable } after retries (fetchJson)
├── DataIntegrityError     — GammaShapeError, ClobShapeError, OpenMeteoShapeError, WuShapeError,
│                            BucketParseError, LadderGapError, KellyDomainError, DistributionError
│                            — an upstream changed shape or internal math hit an impossible state;
│                            never silently swallowed: store flagged row OR fail run + alert
└── ExecutionError         — FillRejected('stale_book'), GateError(reasons), clob errors (live)
```

Policy: **recorded gap ≠ error** — a missing model horizon day, an unfinalized observation, or a
skipped unbettable event is DATA (flags/columns), not an exception. Exceptions are for "the world
changed shape" and "the math went impossible," and they always reach `job_runs` + Slack.

### 11.2 Environment & Configuration

| Variable | Required | Where | Description |
|---|---|---|---|
| SUPABASE_URL | yes | all | project URL |
| SUPABASE_ANON_KEY | yes | web | RLS-scoped client |
| SUPABASE_SERVICE_ROLE_KEY | yes | functions, scripts | service client (never web) |
| DATABASE_URL | yes | scripts, migrations | direct Postgres |
| CRON_SECRET | yes | functions, pg_cron, web (server) | job endpoint auth (≥32 chars) |
| SLACK_WEBHOOK_URL | yes | functions | notifier |
| OPENMETEO_API_KEY | no | functions, scripts | paid tier; presence switches to customer- hosts |
| NEXT_PUBLIC_APP_URL | yes | web, functions | deep links in Slack |
| OPERATOR_EMAIL | yes | web, RLS seed | the single allowed login |
| POLY_PRIVATE_KEY | no (live only) | execute-bet function secrets ONLY | wallet key; never in Vercel env (ADR-10) |
| POLY_FUNDER_ADDRESS / POLY_SIGNATURE_TYPE | no (live only) | trading | proxy-wallet params |

Tunables (bankroll, caps, thresholds, α, σ priors, champion source, trading mode, WU key cache) live in the `config` TABLE (§7.19) — env is for secrets and wiring only.

### 11.3 Naming, time & logging conventions

- Files kebab-case; React components PascalCase.tsx; functions camelCase verb-first; tables/columns snake_case plural; job slugs kebab-case = Edge Function dir = pg_cron name.
- **Time law:** DB stores timestamptz UTC only; `date_local` columns are station-local calendar dates and are always paired with a tz from city/station; ALL local-day math goes through `core/time` (review invariant: no `toLocaleString`/manual offset arithmetic anywhere else).
- **Unit law:** column suffix declares unit (`_c`, `_native`, `_tenths_c`, `_f`); functions take/return what their suffix says; °F cities never have °C-derived integers in grading columns (ADR-04).
- Logging: structured console JSON in functions ({job, periodKey, msg, ...}); `job_runs.stats` carries the run's countable outcomes; the dashboard renders job_runs, not raw logs.

### 11.4 Paper-fidelity contract (preview honesty)

Paper fills intentionally diverge from best-case live execution; every divergence is enumerated, directional, and conservative:

| Dimension | Paper assumption | Live reality | Direction |
|---|---|---|---|
| Entry style | taker at executable ask | GTC possibly maker | paper ≥ live cost |
| Book staleness at fill | worse-of(stored, live re-walk), book ≤5 min | live order at limit price | paper ≥ live |
| Slippage | +1¢ beyond walked book | walked book is the worst case at fill time | paper ≥ live |
| Fee | full taker fee | 0 if maker (+rebates) | paper ≥ live |
| Fill certainty | always fills | maker may not fill | paper overstates volume, not P&L/$ |
| Adverse selection | none modeled | real | live ≤ paper on this axis — the one optimistic bias; mitigated by edge-decile tracking (F-026 reporting) and the 60d gate measuring Brier, not P&L |

`simulateHistoricalEdge` prints this table with every report (§6.22) — the backtest can gate DIRECTION, never justify size.

### 11.5 Security

- RLS deny-by-default; single allow-listed email; service-role confined to Edge Functions + local scripts.
- CRON_SECRET constant-time compared; admin trigger proxies it server-side (never in browser).
- POLY_PRIVATE_KEY only ever in Supabase Edge Function secrets (live phase); `goLiveGate` + chokepoint invariant (§8.3) reviewed in §15.
- No user-generated content; XSS surface is operator-only; still: all rendered strings from upstream APIs (labels, titles) are plain-text rendered, never dangerouslySetInnerHTML.
- WU embedded key: runtime-extracted, stored in config table, redacted in logs/alerts AND in the /admin config render.
- Out-of-band monitoring: a free external uptime pinger (e.g. UptimeRobot) on `GET /api/health` — the alarm that still works when Slack, the webhook, or the whole stack is down (R-18).

---

## 12. Extensibility Guide

How to add things without touching existing code:

- **A new city/station**: zero code — discovery creates the city plus a provisional `stations` row (tz derived from gameStartTime; coordinates filled by seed-stations/OurAirports or manual entry) and alerts for verification; betting stays off until the station is verified, and distributions begin with the first snapshot cycle. If OurAirports lacks the ICAO: one `stations` update (RUNBOOK §3).
- **A new forecast model**: one `models` row (slug must be a valid Open-Meteo string) — snapshots, calibration, weights, and distributions pick it up; weights start at 0 until residuals accumulate.
- **A new distribution method**: implement `(ladder, forecasts, stats, intraday?) → probs` in `core/distributions/`, register in buildDistributionForEvent's source map + ConfigSchema enum. It is auto-scored vs market consensus from day one; promotion via F-019 path. (Planned: `house_isotonic` recalibration layer.)
- **Lowest-temperature markets**: discovery filter add tag 103040 + `kind='lowest'`; buckets/grading already kind-agnostic (winning bucket = bucket containing min); distributions need `temperature_2m_min` snapshot columns — one migration + one config switch (A-8).
- **A second venue (Kalshi)**: `MarketVenue` interface mirroring §6.9's parser outputs (events/ladders/books); edge engine and Kelly are venue-agnostic; grading needs the venue's truth rule (Kalshi = NWS CLI — deliberately different from WU, see research).
- **Maker order strategy (Phase 5)**: extend LiveExecutor with a resting-order mode (post at q − minEdge, monitor, reprice); the bets schema already separates rec_ vs executed_ economics.
- **Approve-in-Slack**: swap webhook for a Slack app; BET_REC blocks gain action buttons hitting /api/bets/{id}/approve with a signed token. Notifier interface isolates this (ADR-11).
- **Phase B semi-auto / Phase C full-auto approval (spec §12)**: a config-gated approval policy evaluated where recommendations are written (poll-markets step 6): `autoApproveMaxStakeUsd` (0 = Phase A manual-only, default) — stakes at or below it are proxied to execute-bet automatically, above it remain manual. Phase C = raising it to the per-trade cap. No new modules; one config key + one branch + audit rows.
- **06/18Z snapshot slots**: config change (slots array) + two pg_cron rows — schema already keys by snapshot_slot (A-12).
- **Capacity testing (spec §13 Phase 6)**: post-live sustain work — once live months accumulate, regress realized edge against stake size from `bets` data to find the erosion curve; explicitly deferred beyond P10 (R-11 carries the honesty note until then).

---

## 13. Risk Register

| # | Risk | Likelihood | Impact | Mitigation (built-in) |
|---|---|---|---|---|
| R-1 | WU embedded key rotates/blocks | High, eventual | Truth pipeline stalls | runtime re-extraction; METAR provisional display; IEM history fallback; CRITICAL alert; paid TWC key is drop-in (same schema); grading waits rather than guesses |
| R-2 | Station change mid-cycle (Paris precedent) | Medium | Forecasting the wrong place = guaranteed losses | per-event resolutionSource parse; temporal city_stations; auto-suspend + manual verify (F-002) |
| R-3 | Open-Meteo terms (non-commercial free tier) | Medium at go-live | Data cutoff | budgeted usage; €99/mo Professional planned at go-live (A-10); host switch is an env var |
| R-4 | DB growth vs plan limits | Certain | Ingest stalls / data loss | honest math (§7.5/§7.11/§7.12): forward ingest alone ≈120 MB/mo unbounded; retention rules on every high-volume table enforced by the downsample cron; storage gauge on /system; **Pro tier ($25/mo, 8 GB) budgeted from P4 — free tier carries P0–P3 only** |
| R-5 | Edge Function 2s CPU / 150s wall | Medium | Job aborts | poll-markets parses ~7 MB of Gamma JSON per tick: structural guards + one-sampled-event zod validation (W15), cpuMs tracked in stats; per-station loops chunked; healthMonitor reaper catches killed isolates |
| R-6 | Polymarket fee/microstructure changes | Medium | Edge math wrong | feeRate read per market from feeSchedule; smoke tests assert shapes; fees.ts is one module |
| R-7 | Gamma/CLOB shape change | Medium | Parsers break | zod schemas + research fixtures; DataIntegrityError → flagged rows, never silent; smoke-live-apis preflight |
| R-8 | MiCA → EU geo-block (post 2026-07-01) | Medium | No live trading from Sweden | paper phase unaffected (public data); goLiveGate re-checks geoblock; Plan B documented (do-not-build-yet): venue abstraction §12 |
| R-9 | Model degradation (KMA-style silent death) | Medium | Stale inputs poison ensemble | per-model null-rate monitoring (§6.14); weights collapse to 0 via MSE; MODEL_DEGRADED alert |
| R-10 | Calibration regime drift (seasonal) | High | Edge turns negative silently | rolling windows; Brier-vs-market daily gate; CALIB_DRIFT + auto-halt (F-027); season-stratified σ is a planned challenger |
| R-11 | Competition compresses edge (5–15 min windows on majors) | High | Few recommendations pass threshold | that's the system working — thresholds hold; the $2k volume floor (not $10k — C4: that would veto 62% of events incl. NYC at lead-1) keeps secondary cities with wider windows in scope; per-bucket depth is the real liquidity check; capacity honesty in docs |
| R-12 | Two snapshots/day miss intraday model flips | Medium | Stale q on fast-moving days | nowcast constraint (lead 0); freshness guard skips >14h-old distributions; 06/18Z slots ready behind config (A-12) |
| R-13 | Paper-vs-live fidelity gap | Certain, bounded | Overconfident go-live | §11.4 contract: all biases conservative except adverse selection — named, tracked by edge-decile |
| R-14 | UMA dispute / resolution ≠ our truth | Low | Grading mismatch | gradeEvent cross-checks Polymarket's own winner; mismatch = CRITICAL + grading_mismatch flag; bets stand as market resolved, not as we think |
| R-15 | pg_cron/pg_net delivery hiccups | Medium | Missed runs | at-least-once + idempotent runJob; healthMonitor staleness matrix; gap-fill recovers forecasts ≤7d |
| R-16 | Swedish tax complexity | Certain (live) | Admin burden | every fill/resolution in bets+ledger; `[POST] /api/admin/export` produces the K4-ready CSV; flagged for accountant — not tax advice |
| R-17 | No PITR on free tier; data loss = evidentiary loss | Low | bets/ledger audit trail gone | weekly `scripts/backup-db.ts` keeping 8 dumps (F-037); Pro tier adds PITR from P4 |
| R-18 | Slack is the single alert channel | Medium | Missed dead-man alarms | sent-on-2xx + resend sweep (ADR-11); external uptime pinger on `/api/health` as the out-of-band backstop |

---

## 14. Implementation Roadmap

Phases are independently verifiable; "done" always includes tests green + typecheck clean. P1–P3 are sequential foundations; P4/P5 parallelizable; P6 needs P4+P5; P7+ layer on P6.

**P0 — Scaffold (foundation)**
Monorepo (pnpm, tsconfig, vitest, CI), Supabase project + migrations 0001–0010 applied, `.env.example`, README. DoD: `pnpm test && pnpm typecheck` green on empty suites; `supabase db reset` idempotent; pg_cron rows registered (functions may 404 until P4); seed config row set (bankroll $1,000).

**P1 — Core domain: parsing & math (the unit-test heart)**
Modules §6.1–6.11 complete with fixture tests from `research/*.json` (gamma events × 4 cities + resolved, CLOB book, Open-Meteo daily/hourly/previous-runs/ensemble, WU obs × 3 stations, METAR, IEM). DoD: every §15 core checklist item; property tests for jointKellyStakes invariants; bucket parser handles all observed label variants; DST window tests (Chicago spring-forward, London fall-back); ≥95% line coverage on core.

**P2 — Reference data + discovery (first live writes)**
seed-stations script; discover-markets job + runJob/_shared plumbing; cities/stations/events/buckets populating. DoD: live run discovers all ~49 cities; stations resolved for ≥45 with coordinates; station-change simulation test (fixture with altered URL) produces suspend+alert; job idempotency proven (re-POST → 409).

**P3 — Ingestion: forecasts + truth**
snapshot-forecasts, snapshot-ensembles, fetch-actuals, metar-nowcast jobs. DoD: 48h of live operation: snapshots present for ≥95% station×model cells per slot; yesterday's WU actuals finalized for ≥45 stations; divergence columns populated; one forced WU-key-refresh exercised; gap-fill repairs a deliberately deleted day.

**P4 — Backfill + calibration**
Upgrade Supabase to Pro FIRST (R-4 — the backfill does not fit the free tier). backfill-forecasts/actuals scripts (budgeted, resumable), run-calibration job, model_stats/calibration_scores filling (slot-keyed), build-distributions producing house_gaussian + house_ensemble. DoD: ≥12 months × ≥40 stations backfilled at leads 1–7 (5 models); model_stats non-null for ≥90% (station, model∈5, lead≤5, slot) cells; distributions sum to 1; σ floors respected; calibration heatmap data queryable.

**P5 — Market pipeline + edge engine**
poll-markets full pipeline (snapshots → consensus → edges → joint Kelly → recommendations → Slack), grade-bets sweep, daily-digest, health-monitor. DoD: recommendations appearing with complete audit objects; paper approval → fill → resolution → P&L → ledger over ≥3 real resolved events; breaker simulation (seeded losses) halts correctly; Slack messages for every alert kind observed.

**P6 — Dashboard**
All 7 pages + 11 API routes (incl. manual-bet, export) + the execute-bet proxy path + auth. DoD: every loader renders real data; approve/skip round-trip through execute-bet; admin halt/resume/config/verify/trigger/manual-bet/export flows audited; EdgeChart matches stored edge_evaluations exactly (display recompute = stored values test); Playwright smoke on the 7 pages.

**P7 — Historical simulation + market-history backfill**
backfill-market-history, simulate-historical-edge with walk-forward honesty. DoD: backtest report generated for ≥6 months × ≥10 cities; house-vs-market Brier table renders on /calibration backtest tab; fidelity table prints with every report.

**P8 — Hardening + docs**
RUNBOOK, DATA-SOURCES, CALIBRATION, TRADING-MATH, GO-LIVE-CHECKLIST; smoke-live-apis in CI; retention/downsample cron verified; storage gauge; failure-drill: kill each upstream (mock) and verify alert + recovery path. DoD: every doc exists and is accurate against code; drill log committed; §15 checklist fully ticked.

**P9 — Paper campaign (60+ days, calendar-gated)**
Operate. Weekly J-3 audits; tune config only through /admin (audited). Exit criteria (the spec's hard rule, made statistically honest per C5): ≥60 out-of-sample days; POOLED time-matched per-event Brier difference vs market_consensus significant at p < 0.05 (paired bootstrap) with point estimate ≤ 0.95×; per-city enablement only where that city's 60d estimate ≤ 1.0× with n ≥ 30 scored events; breakers quiet ≥14 days.

**P10 — Live enablement (dormant → Phase A)**
Wallet setup per GO-LIVE-CHECKLIST, POLY_PRIVATE_KEY in Edge secrets, goLiveGate green, $20 hard cap month one, nightly reconciliation (F-033). DoD: first live fill reconciles against data-api positions to the cent; rollback path (tradingMode='paper') tested before the first order.

---

## 15. Build Verification Checklist

### Module: core/time (§6.1)
- [x] `localDayWindow(tz, dateISO)` — correct UTC bounds for Asia/Seoul, Europe/London, America/Chicago fixtures
- [x] `localDayWindow` — DST spring-forward (23h day) and fall-back (25h day) windows correct
- [x] `localDateAt(tz, instant)` — boundary instants (23:59:59.9, 00:00:00) classify correctly
- [x] `leadDays(now, target, tz)` — 0 on target day local, −1 after local midnight, matches gameStartTime fixtures
- [x] `isLocalDayOver` / `localHour` — consistent with localDayWindow
- [x] InvalidTimezoneError raised on unknown tz everywhere

### Module: core/units (§6.2)
- [x] `cToF`/`fToC` — exact round-trip on integers
- [x] `wuRound(30.6) = 31`; `wuRound(23.4) = 23`; half cases documented + tested
- [x] `metarMaxToNative(30.6, 'F') = 87` (live-verified KORD case)
- [x] `toNative` — °F conversion before bucketization (no double rounding)

### Module: core/buckets (§6.3)
- [x] `parseBucketLabel` — '94-95°F', '87°F or below', '19°C or higher', **bare single-degree '15°C'/'94°F' (9 of 11 buckets on intl fixtures — W1)**, negative degrees, NBSP/EN-dash variants, every label in every research fixture enumerated in one table-driven test
- [x] `parseBucketLabel` — BucketParseError on unknown shapes (never guesses)
- [x] `bucketRange` — ±0.5 continuity; tails → ±Infinity
- [x] `validateLadder` — passes all 4 research event fixtures; fails gap/duplicate/mixed-unit synthetic ladders
- [x] `winningBucket(93°F) = '92-93°F'` idx; LadderGapError on impossible value
- [x] NYC resolved fixture: winner '80-81°F' matches Polymarket outcomePrices

### Module: core/fees (§6.4)
- [x] `takerFeePerShare(0.34, 0.05)` = 0.01122 (docs worked example: 100 sh → $1.12)
- [x] `takerFeeTotal` symmetric at p and 1−p
- [x] `minEdgeRequired` — monotone components; uses observed spread/2 when > buffer floor
- [ ] feeRate read from market_buckets.fee_rate (no hardcoded 0.05 outside config/defaults)

### Module: core/distributions (§6.5)
- [x] `normCdf` — |error| < 1e-7 against reference values
- [x] `gaussianBucketProbs` — Σ=1±1e-9; mass shifts with μ; DistributionError at σ ≤ 0.2
- [x] `gaussianBucketProbs` — °F ladder (2° buckets) and °C ladder (1° buckets) both correct
- [x] `ensembleStats` — weighted mean/std; zero-weight models excluded
- [x] `dressedEnsembleProbs` — ≥20-member guard; reduces to gaussian for identical members
- [x] `impliedDistribution` — normalizes; null when >2 mids missing; clamps degenerate quotes
- [x] `applyRunningMaxConstraint` — eliminated buckets zeroed; renormalized; top-tail edge case keeps mass 1; partial-bucket lift applied when table provided

### Module: core/calibration (§6.6)
- [ ] `updateBias` — seeds on null; converges geometrically on constant error
- [ ] `fitSigma` — null under minN; matches manual std-dev
- [ ] `computeModelWeights` — Σ=1; missing-data models → 0; single-model → 1
- [ ] `brierScore` — 0 perfect / 2 worst-case sanity; matches hand example
- [ ] `expectedCalibrationError` + `reliabilityBins` — synthetic perfectly-calibrated set → ECE≈0; bins carry n
- [ ] `sharpness` — ordering sanity on sharp vs flat sets
- [ ] `correctPoint` — grep-verified as the ONLY site subtracting bias anywhere in the codebase
- [ ] `pairedBootstrapPValue` — seeded reproducibility; returns 1.0 under n<30; **zero-skill Monte Carlo regression: synthetic no-skill data passes the full gate in <5% of 1,000 trials (C5)**

### Module: core/edge + kelly + risk (§6.7–6.8)
- [ ] `executableAsk` — walks depth correctly on the research CLOB fixture (best = normalized first)
- [ ] `computeBucketEdges` — edge math, spread carried, reasons[] populated per failed criterion
- [ ] `applyLiquidityFilters` — each veto (volume ≥ $2k, spread > maxSpread, t-to-close, unverified, halt) individually tested
- [ ] `jointKellyStakes` — property tests scoped to the q > p candidate set (ADR-08 policy): Σf ≤ 1; inclusion ⇔ q/p > c within the set; greedy-excluded candidates have gradient ≤ 0; single-bucket reduces to (q−p)/(1−p); all-zero when nothing passes; KellyDomainError on true domain violations only; p′ ≥ 1 bucket excluded without throwing (W20)
- [ ] `jointKellyStakes` integration — fed fee-adjusted effective prices (p' = p + fee(p) + slippage), verified stakes shrink vs raw prices (W4)
- [ ] `applyKellyFraction` — audit object shows full vs fractional stakes side by side
- [ ] `applyRiskCaps` — cap order per-trade→event→cluster→daily; share flooring respects orderMinSize; capAudit strings record every clamp; sub-$5 stakes dropped
- [ ] `evaluateBreakers` — each rule fires at exactly its threshold (8 losses, −5% day, 25% DD, Brier 0.30, staleness)
- [ ] `exposureSummary`/`clusterOf` — aggregates match seeded fixtures

### Module: core/polymarket (§6.9)
- [ ] `parseStringArray` — double-encoded fixtures; GammaShapeError on malformed
- [ ] `extractStationFromUrl` — US two-middle-segment URL (us/ny/new-york-city/KLGA — W2) AND intl one-segment URLs (EGLC/RKSI/LFPB); null on garbage
- [ ] `targetDateFromEvent` — slug-with-year parse; 2025-stale-slug trap fixture rejected; **Seoul fixture passes (slug june-11 ↔ gameStartTime 2026-06-10T15:00Z with tz='Asia/Seoul' — C6)**; strict check skipped + tz derived when tz unknown
- [ ] `parseGammaEvent` — full NYC/London/Seoul/Paris fixtures → correct unit, station, 11 sorted buckets, tokens, tick sizes (0.01 AND 0.001 present), feeRate 0.05
- [ ] `isZombieEvent` — Jinan fixture flagged; live events pass
- [ ] `normalizeBook` — reorder verified (raw last = best); string→number; hash carried

### Module: core/weather (§6.10)
- [ ] `forecastUrl`/`previousRunsUrl`/`ensembleUrl` — exact param strings vs research-verified URLs; apikey switches host handled by caller config
- [ ] `parseMultiModelDaily` — suffix parsing for all 9 models; per-model null horizons tolerated
- [ ] `parsePreviousRunsHourly` — local-day max via tz; <20-point days dropped; lead suffix × model suffix matrix
- [ ] `parseEnsembleDaily` — single-model member-suffix scheme (fixture-backed); control = member 0; ensembleUrl enforces one-model-per-call (I2)
- [ ] `archiveUrl`/`parseEra5Daily` — ERA5T daily parse vs openmeteo_era5_archive_daily_RKSI.json
- [ ] `historicalForecastUrl` — param string matches the research-verified URL shape
- [ ] `requestWeight` — >10 vars and >2-week cases produce fractional multiples
- [ ] `wuObsUrl` — {ICAO}:9:{CC} format, units e/m
- [ ] `extractWuApiKey` — finds key in saved RKSI history HTML fixture
- [ ] `parseWuObservations`/`wuDailyMax` — KORD units=e fixture → 87; RKSI units=m → 25; empty-obs → null
- [ ] `isFinalized` — next-day obs presence logic
- [ ] `parseMetarJson`/`metarRunningMax` — RKSI fixture; local-day filter correctness
- [ ] `iemNetworkFor` — US 3-letter + {ST}_ASOS; intl ICAO + {CC}__ASOS (two underscores)
- [ ] `iemDailyUrl`/`parseIemDaily` — parse vs iem_daily_ORD fixture; null on empty data array

### Module: core/config (§6.11)
- [ ] ConfigSchema defaults match §6.11 table exactly
- [ ] `parseConfigRows` — DB override wins; ConfigError lists every invalid key

### Module: functions/_shared (§6.12)
- [ ] `runJob` — 401 without secret; 409 only when existing run is ok or young-running; **stale 'running' row taken over by CAS (attempt+1, started_at predicate — W16: two concurrent takeovers → exactly one proceeds)**; 202 fast path; failure → job_runs 'failed' + Slack CRITICAL
- [ ] `fetchJson` — retries 429/5xx with backoff; UpstreamError carries source+status; timeout enforced
- [ ] `notifySlack` — sent=false insert → 2xx flips sent=true; **failed post does NOT consume the dedupe key**; resend sweep delivers it; Slack outage never throws; BET_REC delivery recorded on the bet
- [ ] `gradeEvent` — winner written once (idempotent re-run no-op); pnl math incl. fees; ledger unique per bet; Polymarket-winner mismatch → CRITICAL + flag; **ADR-16 scored-row selection appends to scored_for_leads[] for leads {0,1} — timeline tests use an AMERICAS city (NYC, created 02:01 UTC) and Wellington, not just Seoul (C7); quiet-market case: one row carries both leads (W18)**; RESOLUTION INFO emitted (deduped); streak breaker evaluated
- [ ] concurrent gradeEvent invocations (fetch-actuals + sweep) — winner-claim CAS admits exactly one grader; no double ledger entries, no double scored_for_leads appends, no double alerts (race test)

### Jobs (§6.13–6.19) — each: registered in pg_cron (0009), idempotent, stats recorded
- [ ] discover-markets — 2-page pagination; zombie filter; new-city flow; station-change flow (suspend+alert); unparseable event stored flagged
- [ ] snapshot-forecasts — ≥95% cell coverage on live run; gap-fill repairs deleted day; MODEL_DEGRADED after 3 null runs
- [ ] snapshot-ensembles — member arrays stored; ≥20-member events only feed house_ensemble
- [ ] fetch-actuals — local-day-over gating; provisional→finalized transition; key-refresh path; divergence flags; ERA5T column; triggers gradeEvent
- [ ] metar-nowcast — daytime station selection; batched call; intraday_max monotone; in-process nowcast rebuild
- [ ] build-distributions — champion + challengers written; inputs_hash dedupe; freshness skip; σ floor; °F conversion path
- [ ] poll-markets — **job_locks lease claim/release (C8: overlap exits 'overlapped'; expired lease reclaimable; NO pg advisory session locks anywhere in job code)**; pagination until short page (+ >4-pages WARN); delta-dedupe write rule with unique-key backstop; adaptive heartbeat (30 min candidates / 2 h others); consensus rows; screen-then-book economy (≤15 books/cycle); **fee-adjusted Kelly inputs pre-filtered to q > p′ (W20: p′ ≥ 1 nowcast bucket excluded without killing the event)**; recommendation upsert + refresh + 20%-stake-change re-notify; CAS expiry path (live mode: cancel via execute-bet); hourly edge_evaluations persist; zod-sampling CPU guard with cpuMs stat
- [ ] run-calibration — residual join correctness (one fixture day hand-checked); stats keyed (station, model, lead, **slot**) — 10Z/22Z never pooled (W3); **backfill/gapfill residuals seed BOTH slots ×1.15 σ (W19)**; scores computed on time-matched rows only, **gate stats restricted to (event, lead) pairs where both sources have scored rows (C7)**; pooled bootstrap p-value persisted to the zero-UUID row; stats_version increments; window tags 30d/60d/90d; weekly nowcast_lift rebuild; drift gate halts; promotion report
- [ ] grade-bets sweep — catches artificially un-graded event; market-resolved-but-no-truth CRITICAL; **live-mode reconciliation diff vs mocked data-api positions raises POSITION_DRIFT (F-033)**
- [ ] daily-digest — renders all sections from seeded data incl. edge-decile table; monthly withdrawal reminder fires in live mode (F-036)
- [ ] health-monitor — staleness matrix per job (**discovery threshold 10h — no false nightly alarm, W7**); reaper flips stuck 'running' runs and re-opens the period; unsent-alert resend; dead-man halt fires on stale data; tomorrow-events sanity

### Module: packages/trading (§6.20)
- [ ] PaperExecutor — fill = WORSE-of(stored, live re-walked) ask + 1¢ + fee (W9); caps re-derived IN PLPGSQL inside the single `fill_bet_with_caps` RPC under pg_advisory_xact_lock — **two concurrent approvals of DIFFERENT bets serialize and cannot jointly breach caps (W17)**; TS↔SQL cap-ladder parity test (applyRiskCaps vs RPC on identical fixtures); ERR_CAPS path; 5-min stale-book 422 path; CAS transition (loser of approve-vs-expire race gets 409); ledger entry written once
- [ ] TradeExecutor.cancel — reachable only via execute-bet {action:'cancel'}; paper no-op; live mock pulls the resting order
- [ ] LiveExecutor — unit-tested against clob-client mock (order params: tokenID, price=exec_ask, GTC, negRisk:true, tick respected); no auto-retry on placement error
- [ ] execute-bet — 401/404/409/422/503 response paths; **live gate failure NEVER paper-fills (C1)**; synchronous, no waitUntil
- [ ] goLiveGate — each condition independently flips the verdict; reasons verbatim; gate = 60d + pooled bootstrap p<0.05 + ≤0.95× point + per-city n≥30 & ≤1.0× rule (C5); KYC attestation row checked
- [ ] Invariant: grep-verified no clob-client import / POLY_PRIVATE_KEY read outside packages/trading, and packages/trading imported only by execute-bet + web gate-readout

### API: operator routes (§8.2)
- [ ] `[POST] /api/bets/{id}/approve` — thin proxy to execute-bet; 200 fill shape; 409 wrong status; 422 stale book/caps; 503 gate reasons relayed verbatim; auth enforced; CRON_SECRET never reaches the browser
- [ ] `[POST] /api/admin/manual-bet` — zod validation; paper path proxies to execute-bet; externally-executed live fill recorded verbatim (F-035)
- [ ] `[POST] /api/admin/export` — CSV columns cover every fill + resolution with USD amounts (K4-ready, R-16); date-range filter works
- [ ] `[POST] /api/bets/{id}/skip` — 200/404/409
- [ ] `[POST] /api/admin/halt` + `resume` — halt key writes + audit + Slack; resume confirm mismatch 400
- [ ] `[POST] /api/admin/config` — zod rejects bad keys (400 details); audit rows; bankroll change WARN
- [ ] `[POST] /api/admin/verify-station` — sets verified, re-enables betting; 409 superseded row
- [ ] `[POST] /api/admin/trigger-job` — secret stays server-side; unknown job 400
- [ ] `[POST] /api/admin/promote-source` — server re-check blocks ineligible promotion (409)
- [ ] `[GET] /api/health` — 200/503
- [ ] All routes reject non-operator sessions (401) — RLS + email check

### Data models (§7)
- [ ] Migrations 0001–0010 apply clean on empty DB and re-apply idempotently (db reset)
- [x] Every unique/natural key from §7 exists (cities.slug; city_stations one-current partial; forecast 5-col; ensemble 4-col; observations (icao,date); events (city,date,kind); buckets (event,idx); dist (event,source,hash); model_stats PK; scores PK; bets open-rec partial; ledger (bet,type); job_runs (job,period); alerts (dedupe,day))
- [x] Indexes from §7.5/§7.11 present in migrations (verified by reading SQL, not prose)
- [x] RLS: anon sees nothing; operator email reads all; writes service-role only (tested with anon client)
- [x] config seeded with §6.11 defaults; models seeded incl. disabled traps (kma, ecmwf_ifs04, gfs025)
- [x] Downsample cron enforces EVERY retention rule: market_snapshots tiers (7d/30d/180d), forecast_snapshots 90d lead-0–2@10Z keep, bucket_probabilities resolution+30d scored-rows keep, edge_evaluations 30d, intraday_max 14d, job_runs/alerts_log 90d (fixture rows aged artificially)
- [ ] model_stats PK includes snapshot_slot; queries never pool slots (W3)
- [ ] job_locks lease semantics: claim-by-CAS, expiry reclaim, release-on-completion (C8)
- [ ] job_runs.attempt increments on CAS takeover; unique (job, period_key) never violated (W16)
- [ ] market_snapshots unique (bucket_id, captured_at); overlapping-poll protection via the job_locks lease (W10/C8)
- [ ] bucket_probabilities.scored_for_leads[] appended only by gradeEvent; per (event, source, lead) exactly one row carries that lead
- [ ] calibration_scores.window_tag domain incl. 'backtest'/'nowcast'; zero-UUID pooled row carries bootstrap_p
- [ ] nowcast_lift populated by backfill-actuals; weekly refresh by run-calibration; missing row ⇒ truncation-only nowcast
- [ ] edge_decile_stats view matches hand-computed deciles on seeded bets (W-2)
- [x] bankroll_balance view sum equals manual ledger arithmetic; no stored running-balance column exists (W10)
- [ ] model_stats_history rows written on every stats_version increment
- [ ] edge_evaluations unique (event, bucket, hour); written hourly; queryable from /events page (F-038)
- [x] pg_cron job commands read CRON_SECRET from Vault — `select command from cron.job` contains no literal secret (W11)
- [ ] tmax columns: °F city observations carry units=e integers (spot-check vs WU page)

### Data flows (§9)
- [ ] 9.1 snapshot happy path E2E on live APIs; station-failure branch leaves partial stats + WARN
- [ ] 9.2 discovery E2E; station-change fixture → suspend + verify round-trip re-enables
- [ ] 9.3 truth: provisional→finalized→graded E2E on a real resolved event; our winner == Polymarket winner; WU-key failure branch exercised (forced 401)
- [ ] 9.4 edge→rec→approve→fill→resolve E2E in paper mode on a live market (through the execute-bet proxy)
- [ ] 9.4 race branch — concurrent approve + expire on one bet: exactly one CAS winner, loser 409, no double ledger entry
- [ ] 9.10 digest→review loop renders end-to-end (J-1)
- [ ] ADR-16 row-existence: discovery-seeded distribution exists before the lead-1 cutoff for a same-UTC-day Americas creation (NYC fixture timeline) and a UTC+12/13 city (Wellington)
- [ ] 9.5 calibration run updates stats + scores; drift halt fires on synthetic bad Brier
- [ ] 9.6 nowcast: rising METAR max eliminates buckets in the stored distribution
- [ ] 9.7 backfill scripts resumable (kill mid-run, restart continues from cursor); budget sleeper engages
- [ ] 9.8 dead-man: stop snapshots 30h (clock-mock) → halt:global + CRITICAL
- [ ] 9.9 go-live gate: every condition red→green transition rendered on /admin

### Dashboard (§6.21)
- [ ] 7 pages render with real data; Playwright smoke green
- [ ] EdgeChart display recompute == stored edge rows (no silent drift between engine and UI)
- [ ] Reliability diagram + heatmap match calibration_scores fixtures
- [ ] Bet audit JSON fully visible on /events/[slug] (spec §15: derive stake from stored values)

### Scripts (§6.22)
- [ ] seed-stations covers all discovered ICAOs or prints the manual list
- [ ] backfill-forecasts honors --budget, requestWeight accounting, resumability
- [ ] backfill-actuals WU + IEM-fallback provenance recorded
- [ ] backfill-market-history reconstructs ≥1 resolved event's consensus + winner correctly vs fixture
- [ ] simulate-historical-edge — walk-forward (no peeking: stats at D use only <D data — test with sentinel); scores at ADR-16 cutoffs only; prints fidelity table; writes 'backtest' scores
- [ ] backfill-market-history — consensus rows synthesized at pre-cutoff timestamps only (post-cutoff prices never used — C2)
- [ ] backup-db — produces restorable dump; retention of 8 verified (F-037)
- [ ] smoke-live-apis — one assertion per integration; fails loudly on shape drift

### Docs
- [ ] README quickstart works from clean clone (verified by following it)
- [ ] RUNBOOK covers: WU key incident, station change, dead-man recovery, manual job triggers, backfill ops, Vault secret seeding, weekly backup schedule (F-037), monthly withdrawal-sweep procedure (F-036)
- [ ] DATA-SOURCES / CALIBRATION / TRADING-MATH match implemented formulas (spot-check fee, Kelly, Brier examples)
- [ ] GO-LIVE-CHECKLIST mirrors goLiveGate conditions verbatim



