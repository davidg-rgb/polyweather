# Architecture Review — Maker-Spray Paper Simulator

> Reviewed: 2026-06-22 · Source: `docs/specs/maker-spray-architecture.md`
> Reviewers: Integrity, Coverage, Adversarial (parallel) · Path: Full (operator-chosen)

## Summary
- **Pass 1:** 2 CRITICAL · 9 WARNING (4 integrity edge-asymmetries, 5 adversarial/coverage) · ~10 INFO
- **Pass 2 (focused adversarial re-verify):** see `## Pass 2` below

All Pass-1 CRITICAL + WARNING + the cheap MEDIUM/INFO items were applied in the blueprint revision (status line
"REVISED — Phase-9 Pass-1 applied"). The two CRITICALs were verified against real source before fixing.

## CRITICAL findings (Pass 1) — both fixed

- **C1 — `last_trade` variant reads a field not on the imported type.** `copy-trade.ts:52-61` `BucketSnapshot`
  is `{capturedAt, bid, ask, mid}` — no `lastTrade`; `copytrade-feasibility.ts:167-181` never maps `last_trade`.
  The DB column exists (`0004_markets.sql:76`) but nothing surfaces it.
  **Fix:** the `lastTrade` field lives on a script-local `MakerSnapshot = BucketSnapshot & {lastTrade}` loaded by
  the script; `simulateFill` is generic over `FillSnapshot`; the imported `BucketSnapshot` is untouched (no
  shared-type edit). ADR-03, §2.5 Q1, §6.1/§6.2, §7, R-6 updated.

- **C2 — resolution/entry timezone wrong for every non-UTC city.** `market_events.target_date` is
  station-local (`0004_markets.sql:11`; `gameStartTime`=local-midnight-in-UTC, `ARCHITECTURE.md:829`).
  `(target_date+1)::timestamptz` is off by the city's UTC offset (~+9h Tokyo, ~+11h Sydney, ~−8h US-west) —
  multi-hour, systematic, an order of magnitude past the 30-min grid. db1 inherits the skew but only reads the
  *last* ask (rounds away); the maker model scans the whole post-entry series → material.
  **Fix:** join `cities.tz` (`0002_reference.sql:27`); resolution = `localDayWindow(c.tz, target_date).endUtc`
  (`time.ts:45`, DST-correct); entry = resolution − leadHours; C-2 loads a per-city `AT TIME ZONE c.tz` superset
  window; the precise instant is computed in TS. ADR-05, §6.2, §8.1 C-2, §9, R-2 updated; report prints `maxTzSkewHours`.

## WARNING findings (Pass 1) — all fixed

- **W1 — "fork db1's loaders" overstated.** db1 has no series loader (reads last ask only, `:397-411`). Real
  precedent for `loadBucketSeries` is `copytrade-feasibility.ts loadSnapshots :161-186`. **Fix:** ADR-02 split
  into two lineages (EMOS spine ← db1; series loader ← copytrade); `loadBucketSeries` is the only new query.
- **W2 — `forkRmse ≈1.2991` is window-specific, not an invariant.** db1 docstring (`:30-34`) warns it drifts with
  backfill growth + flags. **Fix:** `forkEqualityRmse` asserts byte-equality to a LIVE db1 run on the identical
  window; 1.2991 is documented as the default-window expectation only. R-3, §6.2, §9, §15 updated.
- **W3 — "ask-touch cannot manufacture a false PASS" overstated** (it's a probabilistic tendency; a briefly-cheap
  winner fills; queue priority ignored). **Fix:** claim softened; the AS diagnostic (`filledHit ≪ allEligibleHit`)
  is now a GATING SANITY (`asSuspect`); ask-touch noted as upper-bound-on-winner-fills too. ADR-03, R-1.
- **W4 — "≥2 stations clear 0" has no multiple-comparison control** (~30% trip on noise, λ≈1.1). **Fix:** binding
  gate = POOLED CI>0; ≥2-stations/not-EHAM demoted to descriptors; a MANDATORY zero-skill Monte-Carlo (<5%) added;
  per-station min-n raised to ≥20. ADR-08, R-7, §6.1 (`zeroSkillMc`), §15.
- **W5 — `makerSprayVerdict` "Calls armEdgeStats (per-station re-stat)" impossible** on its `EvCi` input
  (`stats.ts:195` needs `GradedBet[]`; the twin `copyTradeVerdict :374-388` calls nothing). **Fix:**
  `simulateSpray` populates per-station `filledNetEv` as real bootstrap CIs; the verdict only READS `evCiLo`.
- **Integrity W (×4) — asymmetric `Called by`/`Calls` edges** (`report`, `simulateFill`←crossValidate,
  `makerSprayVerdict`←report, `makerNetEvPerDollar`/simulateSpray). **Fix:** edges reconciled in the revised §6;
  `makerNetEvPerDollar` is reached via `makerEntry` only.
- **Integrity W — §9 `assembleBids` duplicated `makerEntry`'s entry-snapshot resolution.** **Fix:** `makerEntry`
  is the SOLE owner of `snapshotAtOrAfter(entryTs)`; `assembleBids` only sets `entryTs` + passes the series.

## MEDIUM/INFO (Pass 1) — applied
- **M1** entry-lead stability had no owner → `run` runs the sweep + asserts verdict stability (§6.2, P2/P4, §15).
- **M2** Brier sanity absent from the report shape → `brierVsMarket` added to `MakerSprayReport` + checklist.
- **M3** "shared harness unmodified" had no guard → a `git status` checklist line (db1/mos-pointskill/copytrade/
  openmeteo/0010_seed/dash_amsterdam_sim).
- **L1** `--rest-at` flag spelling → CLI accepts `bid|bid+tick|ask-offset`, maps to the internal enum.
- **L2** WO-5 verdict-wording template pinned in `report()`.
- **I1** `makerNetEvPerDollar` relabelled a NEW fn (not a reuse). **I2** invariants test allow-lists `*.test.ts` →
  R-8 caveat. **I3** unwireable `sharpReference` dropped (deferred to §12). **I5** C-2 index confirmed present.
  **I6** determinism note: input arrays SQL-ordered. **I4** gaussianBucketProbs throw-handling confirmed accurate.

## Pass 2 — 2026-06-22 (focused adversarial re-verify)
Single adversarial reviewer, source-verified the four risky fixes + a new-defect sweep.
- **C1 CONFIRMED-FIXED** — `BucketSnapshot` is `{capturedAt,bid,ask,mid}` only (`copy-trade.ts:52-61`); the
  script-local `MakerSnapshot`/`FillSnapshot` superset is TS-sound (optional `lastTrade` ⇒ `BucketSnapshot[]`
  assignable); `last_trade` col exists (`0004_markets.sql:76`).
- **C2 CONFIRMED-FIXED** — `localDayWindow(tz,date).endUtc` is local-day-end in UTC, DST-correct, exported
  (`time.ts:45-54`); `cities.tz` IANA (`0002_reference.sql:27`); the `AT TIME ZONE c.tz` ±-window is a true
  superset for extreme offsets (Sydney +11, US-west −8/−10); `(target_date±1)::timestamptz` survives ONLY in the
  unmodified db1 fork source, correctly cited as not-to-inherit.
- **W2 CONFIRMED-FIXED** — `runDb1` IS exported (`db1...ts:308`) returning `forkRmse`; calling the public
  entrypoint is not the "import private internals" ADR-02 forbids. Prose tightened to `runDb1().forkRmse`.
- **W5 CONFIRMED-FIXED** — twin `copyTradeVerdict` (`copy-trade.ts:374-388`) calls nothing; revised verdict reads
  fields only.
- **NEW (5a) WARNING — zero-skill MC↔verdict circular as written.** FIXED this pass: §6.1 now specifies the MC
  builds a per-shuffle mini-report ({filledNetEv, perStation} only) and the verdict's MC-mode never reads
  `zeroSkillMc` — loop broken.
- INFO nits fixed: W2 prose (`runDb1().forkRmse`), C-2 index noted `DESC`.
- `brierVsMarket` inputs confirmed available (`marketImpliedProbs` `db1...ts:141-146` + `marketProbAtEntry`).

**Verdict: BUILD-READY.** 0 CRITICAL, 0 open WARNING (5a closed this pass), INFO-only residual. Converged in 2 passes.

## Recommended next steps
1. ✅ Pass-1 CRITICAL+WARNING+MEDIUM/INFO applied. 2. ✅ Pass-2 re-verify + 5a fix applied. 3. → Build via the P0–P4 Workflow.
