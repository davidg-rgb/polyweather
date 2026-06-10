# BUILD-STATE — Weather Edge

> The state file for the autonomous build loop. Files are the state — every
> iteration reads this first, works, then updates it. Contract: ARCHITECTURE.md.

## Active Phase

**P1 — Core domain: parsing & math** (§14). P0 is code-complete (two DoD items operator-environment-gated, see Blockers).

## Completed

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

**P1 continues — `core/edge.ts` + `core/kelly.ts` + `core/risk.ts` (§6.7–6.8):** executableAsk book-walking vs the research CLOB fixture (best = normalized first), computeBucketEdges (edge math, spread carried, reasons[]), applyLiquidityFilters (each veto individually tested), jointKellyStakes (greedy threshold solver + ADR-08-scoped property tests + W4 fee-adjusted-input integration + W20 p′≥1 exclusion), applyKellyFraction (audit full-vs-fractional), applyRiskCaps (cap order, share flooring, capAudit strings, sub-$5 drop), evaluateBreakers (each rule at exact threshold), exposureSummary/clusterOf. Then: polymarket (§6.9) → weather (§6.10) → config (§6.11). End of P1: coverage gate ≥95% on core.

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

## Operator TODO

1. **Install Docker Desktop + Supabase CLI** (or skip straight to hosted): then `supabase start && supabase db reset` to confirm the P0 DoD on the real stack.
2. **Create the hosted Supabase project** (free tier OK until P4; **upgrade to Pro before P4 backfill — R-4**), `supabase link`, `supabase db push`.
3. **Seed Vault secrets** on the hosted project: `cron_secret` (≥32 chars, same value as CRON_SECRET) and `project_url` (the project's https URL) — pg_cron commands read both at run time (W11).
4. **Create the Slack incoming webhook** and put it in `.env.local` as `SLACK_WEBHOOK_URL` + in Supabase Edge Function secrets.
5. *(Post-P4, written here in advance)* Full-universe backfill is a multi-day rate-budgeted run; the build loop will only run the 3-station sample (RKSI, EGLL, KORD; 5 models; 12 months; `--budget 2000`). Full command will be added when scripts land in P4.

## Phase Gate Notes

- P9 (60-day paper campaign) and P10 (live enablement) are calendar/operator-gated; start procedures will be written here at P8 completion.
