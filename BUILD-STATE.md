# BUILD-STATE — Weather Edge

> The state file for the autonomous build loop. Files are the state — every
> iteration reads this first, works, then updates it. Contract: ARCHITECTURE.md.

## Active Phase

**P2 — Reference data + discovery** (§14): seed-stations script; discover-markets job + runJob/_shared plumbing; cities/stations/events/buckets populating. P0+P1 complete (P0's two DoD items operator-environment-gated, see Blockers). Note: P2's live-run DoD items (live discovery of ~49 cities, stations for ≥45) need network access to the live APIs — code + fixture tests land first; live verification follows when run.

## Completed

- **P2 progress (iteration 11, 2026-06-10):**
  - Migration 0011_job_rpcs.sql: race-critical mutations as SQL functions so PostgREST callers and PGlite tests run ONE implementation — claim_job_run (insert / already_ran / running_young / W16 started_at-predicate CAS takeover / lost_race), complete_job_run (attempt-guarded so late isolates no-op), claim_alert (ADR-11 insert/retry/skip), mark_alert_sent.
  - `_shared/db.ts` (DbPort + supabasePort wrapper + getServiceDb Deno factory via dynamic npm: import), `_shared/slack.ts` (notifySlack: dedupe→post→flip-on-2xx-only, never throws), `_shared/runJob.ts` (401/409/202 contract, waitUntil-deferred work, failure→failed+Slack CRITICAL, deps-injected for tests). `supabase/tests/pglite-port.ts` = the DbPort test twin.
  - 19 PGlite-backed tests: full claim lifecycle, stale-isolate takeover, the W16 predicate proven directly (mismatched observed started_at moves nothing), late-isolate complete no-op, ADR-11 lifecycle (fail-keeps-key → retry-delivers → skip), runJob 202-before-handler-finishes timing. §15 runJob ticked (note: PGlite is single-session — predicate + sequential outcome proven; true interleaving rests on Postgres row locking, re-verifiable live in P3). Suite: 356 green.
- **P2 progress (iteration 10, 2026-06-10):**
  - `packages/io` (§6.12, Deno+Node portable): http.ts fetchJson (timeout via AbortController, 429/5xx/network retries with exp backoff + jitter, non-retryable 4xx and non-JSON-200 fail fast, UpstreamError carries source/status/retryable) + slack.ts (slackPost returns true only on 2xx and never throws — ADR-11; buildAlertBlocks Block-Kit formatter with severity emoji + optional dashboard link).
  - `supabase/functions/_shared/auth.ts`: requireCronAuth (constant-time compare, fails CLOSED on missing/short CRON_SECRET, AuthError 401) + getEnv (Deno/process probe). Vitest workspace now has 4 projects (core/io/functions/db); root tsconfig covers supabase/functions.
  - 19 new tests (mocked fetch: retry counts, abort timing, init passthrough; auth prefix/extension rejection). §15 _shared fetchJson item ticked. Suite: 337 green.
- **P1 COMPLETE (iteration 9, 2026-06-10):**
  - `core/config.ts` (§6.11): ConfigSchema (every tunable, ranges enforced, jobWallLimitSec invariant documented), parseConfigRows (string-row coercion, non-schema rows ignored, ConfigError lists every invalid key). Seed-parity test: code defaults == 0010 migration values VERBATIM, and every tunable is seeded.
  - Coverage gate: `pnpm test:coverage` enforces ≥95% lines/functions on packages/core/src (excl. type-only types.ts + barrel index.ts) — measured **99.84% lines / 100% functions**; error-paths suite added to close every guard branch. CI now runs the coverage gate.
  - P1 DoD met in full: §6.1–6.11 implemented, every §15 core checklist item ticked (sole exception: applyKellyFraction audit-object item, which by definition lands with poll-markets' audit JSON in P5), Kelly property tests, all observed label variants, DST windows. Suite: 318 tests green.
- **P1 progress (iteration 8, 2026-06-10):**
  - `core/weather/`: openmeteo.ts (5 URL builders matching research-verified shapes + trap-model rejection, parseMultiModelDaily, parsePreviousRunsHourly with <20-point guard + lead-0 base key, parseEnsembleDaily control=member-0 + I2 one-model guard, parseEra5Daily, requestWeight), wu.ts (wuObsUrl, extractWuApiKey runtime 32-hex, parseWuObservations/wuDailyMax, isFinalized), metar.ts (parseMetarJson, metarRunningMax), iem.ts (iemNetworkFor US/intl conventions, iemDailyUrl, parseIemDaily). zod added to core deps (§4 stack).
  - 26 tests across all weather fixtures: KORD 87/RKSI 25 grading values, Seoul local-day METAR maxes (23/20), ensemble 51 series × 7 dates, prevruns 2×8×2 matrix with hand-verified maxes, the saved-HTML WU key extraction. Fixed a time-of-day-flaky retention fixture (same-hour pair now anchored to date_trunc hour). §15 weather 14/14 ticked. Suite: 294 green.
- **P1 progress (iteration 7, 2026-06-10):**
  - `core/polymarket/gamma.ts` (§6.9): parseStringArray (field-named GammaShapeError), extractStationFromUrl (variable middle-segment regex, W2), targetDateFromEvent (slug-with-year + yearless-trap rejection + title cross-check + C6 strict gameStartTime check when tz known), parseGammaEvent (full typed ParsedEvent: sorted buckets, tokens, per-bucket feeSchedule.rate, derivedTzOffset for new cities, ladderProblems attached not thrown), isZombieEvent (expiry OR none-accepting+degenerate-quotes). `core/polymarket/clob.ts`: normalizeBook (raw-last=best reorder both sides, numeric coercion with ClobShapeError, hash/tick/min/negRisk/lastTrade carried).
  - 26 tests against the real fixtures: 4 city events fully parsed (unit/station/11 buckets/both ticks/feeRate 0.05), resolved-event outcomePricesResolved winner '80-81°F', live-captured Jinan zombie flagged + live events pass, tz derivation Seoul +9 / NYC −4. §15 polymarket 6/6 ticked. Suite: 268 green.
- **P1 progress (iteration 6, 2026-06-10):**
  - `core/edge.ts` (§6.7): executableAsk best-first book walk, computeBucketEdges (per-market feeRate override into fee + threshold, reasons[] tokens), applyLiquidityFilters (5 vetoes, pure). `core/kelly.ts` (§6.8): jointKellyStakes greedy threshold solver (c recomputed per inclusion, budget guard, W20 natural exclusion), applyKellyFraction, applyRiskCaps (ordered clamps with depleting shared headrooms, whole-share flooring, capAudit, sub-$5 drop). `core/risk.ts`: evaluateBreakers (6 rules, exact thresholds), exposureSummary, clusterOf. Types: NormalizedBook/BookLevel/EdgeRow/RiskConfig/StakePlan; EdgeConfig extended with probe/filter fields.
  - 38 tests: CLOB-fixture depth walk (0.36678 avg over 3 levels), 300-trial seeded Kelly property suite, W4 fee-adjusted shrink, every cap/breaker/veto individually. §15 §6.7–6.8: 8/9 ticked (applyKellyFraction audit-object item lands with poll-markets' audit JSON in P5). Suite: 242 green.
- **P1 progress (iteration 5, 2026-06-10):**
  - `core/calibration/`: emos.ts (updateBias decay/seed, fitSigma sample-std null-under-minN, computeModelWeights inverse-MSE with non-finite→0 + 1e-6 clamp, correctPoint as sole bias-subtraction site) + scores.ts (brierScore, reliabilityBins non-empty-bins, expectedCalibrationError, sharpness, mulberry32, pairedBootstrapPValue seeded one-sided).
  - 22 tests incl. geometric-convergence factor check, ECE≈0 on perfectly-calibrated synthetic, the codebase-wide grep tripwire for bias subtraction (comment-stripped), and the C5 zero-skill Monte Carlo: 1,000 no-skill trials vs the conjunctive gate (point ≤0.95× AND bootstrap p<0.05) passes <5%. §15 calibration 8/8 ticked. Suite: 204 green.
- **P1 progress (iteration 4, 2026-06-10):**
  - `core/distributions/`: gaussian.ts (A&S 7.1.26 normCdf |ε|<7.5e-8, gaussianBucketProbs with σ≤0.2 floor + shared renormalize), ensemble.ts (ensembleStats weighted/excluding zero-weight, dressedEnsembleProbs ≥20-member + σ guards), consensus.ts (impliedDistribution clamp/floor/null->2-missing), nowcast.ts (applyRunningMaxConstraint: elimination, piecewise-linear lift CDF through (p50,0.5)/(p90,0.9), physical-certainty fallback when prior mass on survivors is 0). ForecastPoint added to types.
  - 35 tests: Φ vs 9 reference values, both ladder geometries vs direct Φ computation, identical-members reduction to gaussian, degenerate-quote clamping, lift-CDF worked examples incl. step case. §15 distributions 7/7 ticked. Suite: 182 green.
- **P1 progress (iteration 3, 2026-06-10):**
  - `core/buckets.ts` (§6.3): parseBucketLabel (tails/ranges/bare single-degree W1; NBSP/EN-dash/EM-dash/U+2212 + negative degrees normalized; strict-after-normalization, BucketParseError never guesses, inverted ranges rejected), bucketRange ±0.5 continuity, validateLadder (tails/contiguity/units/order), winningBucket whole-degree semantics + LadderGapError.
  - 53 tests: all 55 labels across the 5 gamma fixtures enumerated + parsed; all 5 fixture ladders validate; synthetic gap/duplicate/mixed-unit/tail failures; NYC resolved winner '80-81°F' cross-checked against outcomePrices (double-encoded JSON). §15 core/buckets 6/6 ticked. Suite: 147 green.
- **P1 progress (iteration 2, 2026-06-10):**
  - `core/types.ts` (Unit, BucketDef, EdgeConfig), `core/time.ts` (§6.1 — TZDate-backed local-day windows, leads, DST-safe), `core/units.ts` (§6.2 — WU rounding replica incl. −0 guard, A-11 negative-half assumption documented), `core/fees.ts` (§6.4 — fee curve + minEdgeRequired). `InvalidTimezoneError` added to the §11.1 taxonomy (mandated by §6.1, absent from the §11.1 list).
  - 39 new unit tests: fixture-anchored windows (Seoul/NYC gameStartTime), 4 DST transition days (Chicago + London, 23h/25h), boundary-instant classification, leadDays incl. −1 collapse, fall-back repeated wall-hour, fee worked examples + symmetry + monotonicity. §15: core/time 6/6, core/units 4/4, core/fees 3/4 ticked (fee_rate-from-DB invariant awaits P5 consumers).
- **P0 (iteration 1, 2026-06-10):**
  - Monorepo: pnpm workspaces, strict shared tsconfig, vitest workspace (projects: core, db), GitHub Actions CI (typecheck + test).
  - `packages/core`: §11.1 error taxonomy (`errors.ts`) + unit tests.
  - Migrations 0001–0010 per §7: extensions (guarded), reference (clusters/cities/stations/city_stations/models), ingestion (forecast/ensemble/observations/intraday_max/nowcast_lift), markets (events/buckets/snapshots), analytics (bucket_probabilities/model_stats(+history)/calibration_scores/edge_evaluations), trading (bets/bankroll_ledger + bankroll_balance & edge_decile_stats views), ops (job_runs/job_locks/alerts_log/config/config_audit/backfill_progress), RLS (deny-by-default, is_operator()), cron (ops_downsample() + 12 §7.22 registrations, secrets via Vault — W11), seed (12 clusters, 14 models incl. 3 disabled traps, full §6.11 config incl. bankroll $1,000, ledger init row, poll-markets lease).
  - PGlite migration test harness (`supabase/tests/`): applies the real chain against embedded Postgres with Supabase stubs (roles, auth.jwt(), cron.schedule→cron.job recorder, vault table). 55 tests green: keys, indexes, seeds, RLS behavior, cron registrations, W11 no-literal-secret, full retention-rule suite incl. idempotent second pass.
  - `.env.example` (§11.2), README quickstart.

## Next Task

**P2 continues — discover-markets (§6.13) + seed-stations (§6.22):** read §6.13 spec (gamma pagination via tag fixtures, zombie filter, new-city flow with clusterOf region assignment + derived-tz provisional station, station-change suspend+alert flow, unparseable-event flagged storage) and §6.22 seed-stations (OurAirports → stations). Extend DbPort with the upsert surface these need (or add 0012 RPCs where mutations are race-sensitive). Tests: tag-page fixtures drive discovery end-to-end against PGlite (gamma-events-tag*-active.json have real pagination + the Jinan zombies); station-change simulation per §15 (fixture with altered URL → suspend+alert). gradeEvent (§6.12) lands after discovery (needs events+buckets rows to grade). Edge Function index.ts files need `deno check` — Deno not installed → Operator TODO when they land.

## Blockers

- **`supabase db reset` (P0 DoD)** — needs Supabase CLI + Docker (or a linked hosted project). Neither exists on this machine. Migration validity, idempotent re-apply, keys, seeds, RLS, and retention are PGlite-verified (real Postgres, full chain, 2× apply) — §15 box left unticked until the real reset runs. → Operator TODO 1/2.
- **pg_cron rows registered on hosted project (P0 DoD)** — requires the hosted project + Vault secrets. Registration SQL is written and stub-verified. → Operator TODO 2/3.
- **SLACK_WEBHOOK_URL** — variable scaffolded in .env.example; notifier coded against it from P2. BLOCKED on operator creating the webhook.

## Deviations

- **PGlite as P0 migration-verification harness.** §14 P0 DoD says `supabase db reset`; no Docker/CLI exists here. The full migration chain is instead applied to embedded real-Postgres (PGlite) with Supabase-environment stubs (roles, auth.jwt(), cron.schedule recorder, vault table) — strictly additive; migrations are unmodified Supabase SQL. Real reset stays an operator step.
- **0001 extension creates are DO-block guarded** (`raise notice` on failure) so the chain applies in extension-less test environments. On hosted Supabase both extensions install normally.
- **§7.12 "nowcast extrema" interpreted as first + last nowcast row per (event, source)** (time-series extremes) in ops_downsample(). Revisit if the intent was min/max μ.
- **`models.notes` column added** (§7.4 lists no notes field but the seed spec says traps are "seeded enabled=false with notes").
- **`alerts_log` per-day dedupe key goes through UTC** (`(created_at at time zone 'utc')::date`) because `timestamptz::date` is not immutable and cannot be indexed.
- **`applyRiskCaps` proposed items carry `price` + `orderMinSize`** — the §6.8 signature elides them, but flooring to whole shares and respecting the market's min order size is impossible without them. The §6.20 plpgsql RPC parity test must use the same enriched inputs.
- **`parsePreviousRunsHourly` groups by the payload's local-time date prefix** instead of re-deriving windows via localDayWindow: previousRunsUrl always sets `timezone=auto`, so `hourly.time[]` is already station-local and the prefix IS the local day (equivalent bucketing; tz param kept as the documented contract).
- **`iemNetworkFor` takes an optional `usState` param** — the US `{ST}_ASOS` network needs the state, which is not derivable from (cc, icao); US calls without it throw ValidationError.

## Operator TODO

1. **Install Docker Desktop + Supabase CLI** (or skip straight to hosted): then `supabase start && supabase db reset` to confirm the P0 DoD on the real stack.
2. **Create the hosted Supabase project** (free tier OK until P4; **upgrade to Pro before P4 backfill — R-4**), `supabase link`, `supabase db push`.
3. **Seed Vault secrets** on the hosted project: `cron_secret` (≥32 chars, same value as CRON_SECRET) and `project_url` (the project's https URL) — pg_cron commands read both at run time (W11).
4. **Create the Slack incoming webhook** and put it in `.env.local` as `SLACK_WEBHOOK_URL` + in Supabase Edge Function secrets.
5. *(Post-P4, written here in advance)* Full-universe backfill is a multi-day rate-budgeted run; the build loop will only run the 3-station sample (RKSI, EGLL, KORD; 5 models; 12 months; `--budget 2000`). Full command will be added when scripts land in P4.

## Phase Gate Notes

- P9 (60-day paper campaign) and P10 (live enablement) are calendar/operator-gated; start procedures will be written here at P8 completion.
