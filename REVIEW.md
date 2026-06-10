# Architecture Review — Weather Edge

> Reviewed: 2026-06-10
> Source: ARCHITECTURE.md (final: 2,466 lines)
> Reviewers per pass: Integrity, Coverage, Adversarial — parallel, fresh-context each pass
> Ground truth: live-API fixtures in `research/` (reviewers verified claims against raw JSON, not the doc's prose)

## Convergence summary

| Pass | CRITICAL | WARNING | INFO | Doc lines | Notes |
|---|---|---|---|---|---|
| 1 | 9 | 24 | ~25 | 2,119 | 3 reviewers |
| 2 | 4 | 21 | ~12 | 2,358 | 3 reviewers; coverage clean (0 CRITICAL) |
| 3 | **0** | 12 | 3 | 2,436 | 2 reviewers (coverage stood down — stable since pass 2); both declared "converged, no pass 4 needed beyond verifying edits" |
| final | **0** | **0** | 0 open | 2,466 | all pass-3 findings fixed inline; mechanical greps verify |

All CRITICAL and WARNING findings from every pass were fixed inline at the authoritative spots (no appendix-with-precedence). No `[STUCK]` findings. The classic sub-1.0 convergence pattern held: each pass's fixes seeded the next pass's (smaller) findings, and the loop caught them.

## Pass 1 — headline findings (all fixed)

**Adversarial (fixture-verified):**
- **C1** Wallet-key isolation self-contradictory (approve route on Vercel vs key in Edge secrets) → dedicated `execute-bet` Edge Function; web route is a thin proxy; gate failure = hard 503, never a paper fallback (ADR-10).
- **C2** House-vs-market Brier never time-matched — consensus written at 23:50 local has Brier ≈ 0; the entire go-live gate was structurally meaningless → ADR-16 information cutoffs, scored rows, time-matched gate.
- **C3** Storage math 3–6× low; two tables had no retention → honest math, retention rules on every high-volume table, Supabase Pro budgeted from P4.
- **C4** $10k volume filter vetoes 62% of live events incl. NYC at lead-1 (live-data verified) → $2k floor + per-bucket depth as the real liquidity check.
- **C5** 0.95× Brier gate passable by pure noise ≈30% of the time (Monte Carlo) → paired-bootstrap p<0.05 pooled gate + per-city n≥30 rule + zero-skill regression test.
- **C6** gameStartTime cross-check would misdate/reject every non-US event (fixture: Seoul slug june-11 ↔ gameStartTime 2026-06-10T15:00Z) → tz-aware check; tz derived for new cities.
- **W1** Bucket-label grammar missed bare `'15°C'` single-degree labels — **9 of 11 buckets on every °C event** (would have made ~40 cities unbettable).
- **W2** Station-URL parser assumed one middle segment; US URLs have two (`us/ny/new-york-city/KLGA`) — every US station would have failed verification.
- W3–W15: slot-pooled calibration stats, fee-blind Kelly, approve-vs-expire races, stuck-run reaping, Slack dedupe consuming keys on failure, optimistic 30-min paper books, missing snapshot unique key, CRON_SECRET in committed SQL (→ Vault), nowcast tail contradiction, hardcoded 2-page pagination, unpersisted edge evaluations, zod CPU budget.

**Coverage:** spec's withdrawal discipline and `/admin` manual bet entry silently dropped (→ F-035/F-036); F-033 reconciliation had no implementing job (→ grade-bets live branch); ERA5 path had no parser; Phase B/C seam undocumented.

**Integrity:** `winning_bucket` vs `winning_bucket_idx`; `'iem'` vs `'iem_fallback'`; discovery staleness 8h vs real 9h gap (false nightly CRITICAL); ~20 call-graph asymmetries; section-reference drift.

## Pass 2 — fix-induced findings (all fixed)

- **C7** ADR-16 cutoffs incoherent with build schedule: Americas events are created the same UTC day as their lead-1 cutoff, builds ran only 10:50/22:50 → house lead-1 scored rows would never exist for 16 cities; lead-2 rows can never exist for anyone (creation is after the cutoff); gate pairing was unde­fined → discovery-seeded builds, leads {0,1} only, both-sources pairing rule, Americas+Wellington timeline tests.
- **C8** pg advisory locks are session-scoped and broken over PostgREST's pooled connections (leak → permanent 'overlapped' → self-inflicted dead-man halt) → `job_locks` lease row claimed by CAS with expiry = wall limit.
- W16 runJob takeover violated the unique key and raced the reaper → CAS claim with `started_at` predicate + `attempt` counter.
- W17 caps TOCTOU across concurrent approvals of different bets → caps re-derived in plpgsql inside `fill_bet_with_caps` under `pg_advisory_xact_lock` (single-RPC, pool-safe).
- W18 `scored_for_lead smallint` collides when one row is the cutoff row for both leads → `scored_for_leads smallint[]`.
- W19 backfill/gapfill residuals unrepresentable in slot-keyed stats → seed both slots ×1.15 σ; nearest-slot rule for gapfill.
- W20 fee-adjusted price p′ ≥ 1 reachable → exclusion (never a throw); pre-filter to q > p′.
- Coverage W-1/W-2: city-page market overlay restored; edge-decile stats given a home (`edge_decile_stats` view).
- Integrity: 2 dependency-boundary contradictions (→ `packages/io`; web may import `gate.ts` only, lint-enforced), broken §6.20a code fence, undefined lift table (→ `nowcast_lift` §7.8a), `window_tag`, + ~25 smaller items.

## Pass 3 — convergence check (all fixed)

Both reviewers: **"Converged — no architectural contradictions; remaining items are one editorial pass."** Zero CRITICAL.
- `jobWallLimitSec` defined with the invariant (≥ isolate lifetime) that closes the lease/takeover races.
- Lease release holder-guarded in a finally-path; 'overlapped' exit writes a terminal job_runs state.
- New-station bootstrap: discovery inserts a provisional `stations` row (tz derived; FK satisfied); ADR-16 guarantee correctly scoped to cities with ≥1 snapshot cycle.
- gradeEvent winner-claim CAS gates the whole grading pass; `scored_for_leads` append guarded — concurrent graders produce exactly one pass.
- fill RPC explicitly re-derives the cap ladder in plpgsql (TS `applyRiskCaps` is sizing/display, parity-tested) — closing the would-be reintroduced W17.
- Kelly optimality claims scoped to the positive-edge candidate set; hedge-exclusion stated as deliberate policy; solver sized over PASSING buckets only.
- Editorial shrapnel: §6.13 cron line, stale advisory-lock sentence, lead-2 leftover in the backfill script, duplicate http.ts in the tree, nowcast_lift builder attribution, migration-comment omissions, Wellington NZST correction.

Pass-3 reviewer one-liners worth keeping: the lease's DB-side clock makes claims race-free; runJob CAS admits exactly one handler per period; the fixture timelines confirm ADR-16 seeding for the tightest case (~45-min margin, UTC−3 cities); consensus scored rows exist at cutoffs even for unmoved books (step-2 consensus is tick-level, independent of snapshot dedupe); a fresh stored book fills even when CLOB is down.

## Stop rationale

Skill stop condition "zero CRITICAL and zero WARNING" reached after applying pass-3 fixes; both pass-3 reviewers independently stated no pass 4 was needed beyond verifying the edits landed, which was done mechanically (anchor/stale-term greps + fence parity, all green). Re-running three agents to confirm one-line text edits is the documented diminishing-returns case.

## Recommended next steps

1. Build per §14 roadmap (P0 scaffold → P1 core domain with `research/*.json` as test fixtures).
2. At P1, capture the one missing fixture: a multi-model Ensemble API response (the design avoids needing it by using one-model-per-call, but a fixture would let the alternative be tested).
3. Re-verify the Polymarket fee schedule and geoblock list at build time and again at go-live (R-6, R-8 — both are one-call checks in `smoke-live-apis`).
4. The 60-day paper campaign (P9) is calendar-gated and cannot be compressed; the backtest (P7) gates direction only.
