# Maker-Spray Paper Simulator — Architecture Blueprint

> Generated from: `MAKER-SPRAY-SIM.md`
> Date: 2026-06-22 · Status: REVISED (Phase-9 Pass-1 applied — see `REVIEW.md`)
> Output location: `docs/specs/` (the project-wide `ARCHITECTURE.md` is the SYSTEM blueprint — NOT this; never touch it)

## Table of Contents

1. Executive Summary · 2. Requirements Analysis · 3. ADRs · 4. Tech Stack · 5. Project Structure ·
6. Module & Function Definitions · 7. Data Models · 8. Interface Contracts · 9. Data Flow · 10. Dependency Map ·
11. Cross-Cutting Concerns · 12. Extensibility · 13. Risk Register · 14. Roadmap · 15. Build Verification Checklist

---

## 1. Executive Summary

The maker-spray paper simulator closes the **4th and last** badatmath replication angle. Three are already
falsified (`WALLET-RECON-HANDOFF.md`): forecast-beats-market + day-before-edge (KILL-GATE 2), copy-trade mirror
(§11). The unmeasured variable: **does resting a MAKER bid below the ask on OUR EMOS forecast clear zero EV?**
KILL-GATE 2 measured `calibratedP − ask` (taker, efficient); this measures `calibratedP − rested_bid` with a
fill model that embeds adverse selection from the real `market_snapshots` book evolution.

One pure module (`packages/core/src/sim/maker-spray.ts`, the maker twin of `sim/copy-trade.ts`) + one research
script (`scripts/research/maker-spray-feasibility.ts`). Two distinct reuse lineages (clarified after Pass-1
review): the **EMOS spine** forks from `db1-daybefore-efficiency.ts`; the **snapshot-series loader** forks from
`copytrade-feasibility.ts`'s `loadSnapshots`. Exactly **one** genuinely new thing: the **maker fill model**
(`simulateFill`). Read-only; no migration, no trading import, no prod write. Pre-registered kill-criterion
(frozen, WO-5 discipline). Expected outcome: a clean efficiency confirmation (FAIL → rail dormant). The number is
the deliverable either way.

The depth is spent where the risk is — the fill model, the **station-local→UTC timezone correctness** (the
binding correctness risk, Pass-1 C2), the forkRmse equality gate, and the statistical validity of the verdict.

## 2. Requirements Analysis

### 2.1 Core Features
- **F-001** — Walk-forward EMOS → calibrated bucket probs (FORK the EMOS spine from `db1`, not re-derived).
- **F-002** — Load the **full** book time-series per bucket from `market_snapshots` (fork `loadSnapshots` from
  `copytrade-feasibility.ts`; the only new query is the wider, tz-correct window).
- **F-003** — Choose a rested maker bid price per cheap (<0.25) bucket (`bid` / `bid+tick` / `ask−offset`).
- **F-004** — Maker fill model: filled iff `min(best_ask after entry) ≤ p_rest` (ask-touch) — embeds adverse selection.
- **F-005** — Grade filled positions vs `winning_bucket_idx`; fee-net EV/$1 (no maker rebate by default).
- **F-006** — Aggregate: fill rate, filled-position fee-net EV (bootstrap CI), edge, the adverse-selection
  diagnostic, **Brier(ours) vs Brier(market-at-entry)**, per-station, the **zero-skill Monte-Carlo** false-positive rate.
- **F-007** — Adjudicate the frozen kill-criterion (`makerSprayVerdict`); binding gate = pooled fee-net-EV CI>0.
- **F-008** — Fill-model cross-validation against badatmath's own cheap fills (rigor anchor; `--cross-val`).
- **F-009** — CLI readout + JSON + spray-protocol by-product + the honest coverage/timezone-skew caveats.
- **F-010** — Pure-fn unit tests (deterministic, `[]`/NaN-safe) + fork-equality gate vs a live db1 run.

### 2.2 User Roles & Journeys
Single role: the operator/researcher, offline. One journey: *run the study → read the verdict → record it in
`WALLET-RECON-HANDOFF.md` §12 + memory.* No end-user, no service, no UI.

### 2.3 Constraints
Read-only (no prod write, no migration, no Edge Function, no cron, no web). **No `packages/trading` import** —
note the §15 invariants test allow-lists `*.test.ts` (Pass-1 I2), so the test file must self-discipline too.
Deterministic (seeded `mulberry32`, seed 42; input arrays are SQL-ORDERED, not insertion-order-dependent).
Pure + total (junk → zeroed/NaN, never throws). Fork — never EDIT — the shared `mos-pointskill`/`db1` harness.
Canonical fee math only (`takerFeeTotal`/`takerFeePerShare`).

### 2.4 Integrations
None new at runtime beyond the existing DB (`makeScriptDb`). `--cross-val` reuses the keyless public-Polymarket
wallet client + `scripts/lib/polymarket-crawl.ts` (same `/activity` crawl forensics/copy-trade already use).

### 2.5 Open Questions / Resolved Ambiguities
| # | Question | Resolution |
|---|---|---|
| Q1 | Fill trigger: ask-touch vs last-trade? | **ADR-03** — ask-touch default (uses `BucketSnapshot.ask`); last-trade is a variant on a script-local `MakerSnapshot` that carries `lastTrade` (the imported `BucketSnapshot` does NOT — Pass-1 C1). |
| Q2 | Where to rest? | **ADR-04** — `bid` default; `bid+tick`, `ask-offset` variants. |
| Q3 | Resolution/entry timezone? | **ADR-05** — `target_date` is STATION-LOCAL; resolution = `localDayWindow(tz, target_date).endUtc`; entry = resolution − leadHours. Do NOT use db1's `(target_date±1)::timestamptz` (Pass-1 C2). |
| Q4 | Maker rebate? | **ADR-06** — default 0; `--maker-rebate` optimistic sensitivity. |
| Q5 | One bid/bucket or modal? | **ADR-07** — spray ALL cheap (<0.25) buckets with a book. |

## 3. Architecture Decision Records

**ADR-01 — Pure-core module + research script** (mirrors `copy-trade.ts` / `db1`). Pure analytics in
`packages/core/src/sim/maker-spray.ts`; DB crawl + EMOS walk-forward in `scripts/research/maker-spray-feasibility.ts`.
*Why:* house idiom; testable pure logic; the §15 invariant protects the seam. *Rejected:* monolithic script
(untestable); extending `copy-trade.ts` (different question — maker self-play, not follower-mirror).

**ADR-02 — Two fork lineages, NEITHER edits the shared harness** (revised, Pass-1 W1). (a) The **EMOS spine** —
`EmosStation` + the forecast/obs/event/ladder/config loaders + the walk-forward fold + the `forkRmse`
accumulator — forks from `db1-daybefore-efficiency.ts` (these are inline in `runDb1`, not exported → copy, don't
import). (b) The **snapshot-series loader** forks from `copytrade-feasibility.ts`'s `loadSnapshots`
(`:161-186`) — db1 has NO series loader (it reads only the last `best_ask`, `:397-411`), so framing F-002 as a
"db1 delta" was wrong. (c) `loadBucketSeries` (the wider tz-correct window) is the only genuinely new query.
*Why:* WALLET-RECON precedent + LEARNINGS — fork loaders, prove with the equality gate, never mutate the shared
point-skill harness.

**ADR-03 — Fill trigger = ask-touch, conservative-DEFAULT (claim softened, Pass-1 W3).** A resting BUY at
`p_rest` is filled iff some post-entry snapshot has `best_ask ≤ p_rest`. It **embeds adverse selection**: the ask
collapses toward our bid on buckets the market marks DOWN (losers) → fills; rises away on winners → no fill. **It
is EXPECTED to bias measured EV down, but this is a probabilistic tendency, NOT a proof** (a winner briefly cheap
at entry fills and counts; `min over the window` fills any bucket whose ask momentarily dipped). It also ignores
queue priority (a bid resting AT the bid is behind existing size) → it is an *upper bound on winner-fills* as
well as a *lower bound on loser-fills*. **Therefore the adverse-selection diagnostic (`filledHitRate ≪
allEligibleHitRate`) is a GATING SANITY:** if AS does NOT appear, the pessimism assumption failed and the verdict
is flagged suspect. The `last_trade` variant + the F-008 cross-val quantify the gap. *Rejected:* a probabilistic
queue model (no queue data, unfalsifiable).

**ADR-04 — Rest at best_bid by default** (`bid+tick`, `ask−0.07` variants). badatmath rests at/near the bid
(fill 0.107 vs ask 0.181; 65% below mid). Only buckets with a usable bid AND `p_rest < cheapMax` enter the study.

**ADR-05 — Resolution = station-LOCAL end-of-day in UTC; do NOT inherit db1's UTC proxy** (revised, Pass-1 C2 —
the binding correctness fix). `market_events.target_date` is **station-local** (`0004_markets.sql:11`;
`gameStartTime` = local midnight in UTC, `ARCHITECTURE.md:829`). `(target_date+1)::timestamptz` is wrong by the
city's UTC offset — ~+9h for Tokyo/Seoul, ~+11h for Sydney, ~−8h for US-west — i.e. **multi-hour, systematic per
city, an order of magnitude past the 30-min grid.** db1 inherits the same skew but only takes the *last* ask
(a point read where hours round away); the maker model **scans the whole post-entry series**, so the skew is
material. **Fix:** join `cities.tz` (exists, `0002_reference.sql:27`) and compute the resolution instant with the
DST-correct house helper `localDayWindow(tz, target_date).endUtc` (`packages/core/src/time.ts:45`);
`entryTs = resolutionTs − entryLeadHours`. The C-2 SQL loads a generous UTC superset window via
`… AT TIME ZONE c.tz` (correct per-city, index-served); the precise resolution/entry instants are computed in TS
via `localDayWindow` (pure, testable). The report prints the per-city UTC-offset skew it corrected.

**ADR-06 — No maker rebate by default.** Charge `takerFeeTotal(p_rest, shares, feeRate)`, rebate 0; `--maker-rebate R`
is a clearly-flagged optimistic sensitivity (edge must come from the cheaper price, not an unverifiable rebate).

**ADR-07 — Spray ALL cheap buckets** (badatmath sprays ~6/city·day, max 16 — §11; not one modal pick).

**ADR-08 — Frozen kill-criterion; the BINDING gate is the pooled CI** (revised, Pass-1 W4). **PASS = the
FILLED-position fee-net EV/$1 95% bootstrap CI lower bound > 0 (pooled).** The "≥2 stations clear 0" and
"not-EHAM-only" are **robustness DESCRIPTORS reported alongside, not co-equal AND-gates** — with ~44 noisy
per-station CIs, ≥2 clearing by chance under zero edge is ~30% (Poisson(λ≈1.1)), so it is the *weakest* link, not
a strengthener. Instead, a **mandatory zero-skill Monte-Carlo** (shuffle `won` within each station, re-run the
verdict ~1000×, report empirical P(PASS)) calibrates the false-positive rate and must be <5%; per-station min-n
raised to ≥20 (a 5-bet EV bootstrap CI is not credible). Frozen in `MAKER-SPRAY-SIM.md` §9 + the module
docstring; a second agent adversarially re-verifies before any escalation; thresholds are never moved to fit a result.

## 4. Tech Stack
Inherited, no additions. TypeScript (strict) monorepo; `pnpm tsx` scripts; `vitest`; Node DB via `makeScriptDb`.
The pure module imports only `core` siblings + `copy-trade.ts`. **No new dependency.**

## 5. Project Structure
```
packages/core/src/sim/
  maker-spray.ts            # NEW — pure maker-spray analytics (the maker twin of copy-trade.ts)
  maker-spray.test.ts       # NEW — pure-fn unit tests (deterministic, []/NaN-safe)
  copy-trade.ts             # REUSE — import BucketSnapshot, snapshotAtOrBefore/After (bid/ask/mid only — NO lastTrade)
  stats.ts                  # REUSE — armEdgeStats, bootstrapMeanCi, meanConfidenceInterval, wilsonInterval, GradedBet
scripts/research/
  maker-spray-feasibility.ts       # NEW — impure spine; defines MakerSnapshot (BucketSnapshot+lastTrade); loads + runs
  maker-spray-feasibility.test.ts  # NEW — loader/assembly + fork-equality tests
  db1-daybefore-efficiency.ts      # FORK SOURCE (EMOS spine) — do NOT edit
  copytrade-feasibility.ts         # FORK SOURCE (loadSnapshots → series loader) — do NOT edit
packages/core/src/
  distributions/gaussian.ts # REUSE — gaussianBucketProbs ; calibration/emos.ts — correctPoint/computeModelWeights/fitSigma/updateBias
  calibration/scores.ts     # REUSE — brierScore (the Brier sanity, F-006) ; fees.ts — takerFeeTotal/takerFeePerShare
  time.ts                   # REUSE — localDayWindow(tz, dateISO) (ADR-05 timezone fix)
  index.ts                  # REUSE — parseConfigRows, toNative, fToC, BucketDef
MAKER-SPRAY-SIM.md          # requirements + frozen kill-criterion · WALLET-RECON-HANDOFF.md §12 (NEW) — the outcome
```

## 6. Module & Function Definitions

### 6.1 `packages/core/src/sim/maker-spray.ts` (pure)
> Maker twin of `copy-trade.ts`. Imports `BucketSnapshot` (bid/ask/mid ONLY), `snapshotAtOrAfter`,
> `snapshotAtOrBefore` from `./copy-trade.ts`; `armEdgeStats`/`bootstrapMeanCi`/`meanConfidenceInterval`/
> `wilsonInterval`/`GradedBet` from `./stats.ts`; `takerFeeTotal` from `../fees.ts`; `brierScore` from
> `../calibration/scores.ts`; `mulberry32` from `../calibration/scores.ts` (for the zero-skill MC). The
> `lastTrade` field lives on the script-local `MakerSnapshot` (§6.2), NOT on the imported `BucketSnapshot`
> (Pass-1 C1) — so `simulateFill` is generic over `{ capturedAt; ask; lastTrade? }`.

**Types** (exported): `RestRule = 'bid'|'bid_plus_tick'|'ask_offset'`; `FillModel = 'ask_touch'|'last_trade'`;
`FillSnapshot = { capturedAt: Number; bid: Optional<Number>; ask: Optional<Number>; mid: Optional<Number>;
lastTrade?: Optional<Number> }` (structural superset of `BucketSnapshot`); `MakerSprayOpts`; `RestingBid`;
`MakerEntry`; `EvCi` (re-export from copy-trade); `BrierDelta`; `AdverseSel`; `ZeroSkillMc`; `MakerSprayReport`;
`MakerSprayVerdict`; `CrossValResult`.

```
restPrice(entry: FillSnapshot, rule: RestRule, opts: { tickSize: Number; askOffset: Number }): Optional<Number>
  Purpose: rested bid price from the entry book, tick-rounded DOWN, validated (0,1].
  Returns: p_rest in (0,1], or null when the needed price is missing/unusable.
  Error cases: null on null/≤0/>1; never throws.
  Called by: makerEntry      Calls: (arithmetic + a local usablePrice guard)

simulateFill(restPx: Number, postEntry: List<FillSnapshot>, model: FillModel): { filled: Boolean; minAskAfter: Optional<Number>; fillIdx: Optional<Number> }
  Purpose: THE NOVEL PIECE. Does a BUY resting at restPx fill before resolution, from the real book?
    'ask_touch' (default) → filled iff min(best_ask over postEntry) ≤ restPx (ADR-03).
    'last_trade' (variant) → filled iff any postEntry.lastTrade ≤ restPx (requires MakerSnapshot.lastTrade).
  Returns: { filled, minAskAfter (diagnostics), fillIdx (first crossing) }.
  Error cases: empty/non-finite postEntry → { filled:false, minAskAfter:null }; never throws.
  Called by: makerEntry, crossValidateFillModel      Calls: (none)
  NOTE: ask_touch is EXPECTED-pessimistic, not provably so (ADR-03) — the AS diagnostic gates the verdict.

makerNetEvPerDollar(restPx: Number, won: Boolean, feeRate: Number, rebate: Number): Number
  Purpose: fee-net EV/$1 as MAKER at restPx. shares=1/restPx; win→shares·(1−restPx); loss→−1; minus
           max(0, takerFeeTotal(restPx,shares,feeRate) − rebate·shares). NEW fn (not a reuse — copy-trade's
           netEvPerDollar has no rebate arg, Pass-1 I1).
  Returns: fee-net EV/$1; NaN on bad restPx.
  Called by: makerEntry      Calls: takerFeeTotal

makerEntry(bid: RestingBid, opts: MakerSprayOpts): MakerEntry
  Purpose: simulate ONE resting maker bid end-to-end. SOLE owner of entry-snapshot resolution (Pass-1 integrity).
  Params: bid = { conditionId, bucketIdx, calibratedP, marketProbAtEntry, bucketWon, feeRate, tickSize,
                  citySlug, station, tzOffsetHours, targetDate, resolutionTs, entryTs, snapshots: FillSnapshot[] }.
  Returns: MakerEntry { restPx, entrySnapshot, eligibleCheap, filled, minAskAfter, won, netEvFilled (NaN if
           unfilled), edgeFilled (won−restPx, NaN if unfilled), restVsMid, leadHours }.
  Error cases: no usable entry book / p_rest null → { eligibleCheap:false, filled:false, netEvFilled:NaN }.
  Called by: simulateSpray      Calls: snapshotAtOrAfter, restPrice, simulateFill, makerNetEvPerDollar

simulateSpray(bids: List<RestingBid>, opts: MakerSprayOpts): MakerSprayReport
  Purpose: run the spray; filter to cheap-eligible with a usable book; simulate each; aggregate.
  Returns: MakerSprayReport {
    nCandidates, nCheapEligible, nFilled, fillRate,
    filledNetEv: EvCi  (★ BINDING HEADLINE — bootstrapMeanCi over filled netEvFilled, seed 42),
    filledEdge: { mean, ciLo, ciHi, n }  (meanConfidenceInterval over filled won−restPx),
    adverseSelection: AdverseSel { filledHitRate, allEligibleHitRate, nFilled, nEligible, asConfirmed:Boolean },
    brierVsMarket: BrierDelta { ours, market, delta, nEvents }  (brierScore vs market-implied-at-entry, F-006),
    zeroSkillMc: ZeroSkillMc { pPass, iters }  (shuffle won within station, re-verify ~1000×, P(PASS); ADR-08),
    perStation: Map<station, { filledNetEv: EvCi; nFilled }>  (each a REAL bootstrap CI, so the verdict only READS it),
    restVsMid: { mean, fracBelowMid, n }, coverage: { nWithBook, nWithPostEntrySeries, gridMedianGapSec, maxTzSkewHours } }
  Error cases: empty/all-ineligible → zeroed report (NaN point estimates), never throws.
  Called by: run + tests      Calls: makerEntry, armEdgeStats, bootstrapMeanCi, meanConfidenceInterval, brierScore, makerSprayVerdict (MC-mode only — see NOTE), mulberry32
  NOTE (Pass-2 5a — the MC is NOT circular): the zero-skill MC does NOT re-run the verdict on the OUTER report.
  Each iteration shuffles `won` within each station, recomputes ONLY a lightweight mini-report
  { filledNetEv, perStation } (no `zeroSkillMc` field, no Brier/AS), and calls makerSprayVerdict in MC-mode on
  THAT. `pPass` = fraction of iterations whose mini-verdict passes the pooled gate. The outer report's
  `zeroSkillMc` is then assembled from those iterations — so the verdict→report→MC→verdict loop is broken: the
  MC path reads only `filledNetEv`, never `report.zeroSkillMc`.

makerSprayVerdict(report: MakerSprayReport, opts: { marginThreshold?: Number; minStations?: Number }): MakerSprayVerdict
  Purpose: adjudicate the FROZEN criterion (ADR-08). BINDING gate = report.filledNetEv.evCiLo > 0 (pooled).
           Reads per-station filledNetEv.evCiLo (already computed) to COUNT clearing stations — does NOT re-stat
           (Pass-1 W5: cannot derive armEdgeStats from an EvCi; the twin copyTradeVerdict calls nothing).
           MC-mode (Pass-2 5a): an optional flag makes it read ONLY filledNetEv + perStation from a per-shuffle
           mini-report and never touch zeroSkillMc/asSuspect — so it is safe to call inside simulateSpray's MC.
  Returns: MakerSprayVerdict { pass (pooled evCiLo>0), clearsMargin (pass AND ev≥marginThreshold, default .02),
           stationsClearing: String[], ehamOnly, zeroSkillPPass, asSuspect (¬report.adverseSelection.asConfirmed),
           filledNetEv, marginThreshold, summary }.
  Error cases: NaN CI → pass:false (insufficient evidence fails the gate, goLiveGate idiom).
  Called by: run, tests, simulateSpray (zero-skill MC)      Calls: (reads report fields only)

crossValidateFillModel(realFills: List<{ restPx: Number; postEntry: List<FillSnapshot> }>, model: FillModel): CrossValResult
  Purpose: F-008 anchor. badatmath's OWN cheap fills DID execute at their price; what fraction does our fill
           model PREDICT filled? Low agreement ⇒ 30-min grid too coarse ⇒ headline caveated, not trusted.
  Returns: { agreementRate, n }.  Empty → { agreementRate:NaN, n:0 }.
  Called by: run (when --cross-val)      Calls: simulateFill
```

### 6.2 `scripts/research/maker-spray-feasibility.ts` (impure spine)
> Forks the EMOS spine from db1 (ADR-02a) and `loadSnapshots` from copytrade-feasibility (ADR-02b). Defines the
> script-local `MakerSnapshot = BucketSnapshot & { lastTrade: number|null }` (Pass-1 C1). Read-only.
```
loadBucketSeries(db, icaos, from, to, lookbackDays): Map<eventId, Map<bucketIdx, MakerSnapshot[]>>
  Purpose: F-002. Full ascending series per resolved event×bucket over the tz-correct UTC window (C-2, ADR-05).
           Maps rows → MakerSnapshot { capturedAt(unix), bid, ask, mid, lastTrade }. Forks copytrade loadSnapshots,
           adds last_trade + the wider AT-TIME-ZONE window.
  Side effects: one read-only SQL (C-2).      Called by: run      Calls: db.query

assembleBids(events, emosState, seriesMap, cities, opts): { bids: List<RestingBid>; forkRmse, forkN }
  Purpose: walk-forward fold (mirrors db1 verbatim) → calibratedP via gaussianBucketProbs; per resolved event
           set resolutionTs = localDayWindow(c.tz, target_date).endUtc, entryTs = resolutionTs − entryLeadH
           (ADR-05), marketProbAtEntry = ask at entry, tzOffsetHours for the skew report; emit one RestingBid
           per bucket WITH a series. Retains the forkRmse accumulator. Does NOT resolve the entry snapshot
           (makerEntry owns that, Pass-1 integrity) — it only sets entryTs + passes the series.
  Called by: run      Calls: EmosStation.blendedMu/sigma/fold (fork), gaussianBucketProbs, toNative, localDayWindow

forkEqualityRmse(db, args): { db1Rmse, makerRmse, equal }
  Purpose: Pass-1 W2 — call the EXPORTED `runDb1(args).forkRmse` (db1's public entrypoint — NOT its private inline
           loaders, so ADR-02 "copy don't import" is not violated, Pass-2) AND our forked accumulator on the
           IDENTICAL window/scope; assert byte-equality.
           The frozen 1.2991°C is only the documented DEFAULT-window expectation, NOT the gate (it drifts with
           backfill growth + flags — db1 docstring :30-34).
  Called by: run / the fork-equality test      Calls: (the forked accumulator + db1's)

run(args, deps): MakerSprayResult
  Purpose: load → assemble → simulateSpray → makerSprayVerdict → (optional) crossValidate → report. When args
           carries multiple entryLeads/fillModels, runs the SWEEP and asserts verdict stability (M1).
  Returns: { report, verdict, forkEquality, sweep?, crossVal? }.
  Side effects: read-only DB; console via deps.log.      Called by: CLI entrypoint
  Calls: loadBucketSeries, assembleBids, forkEqualityRmse, simulateSpray, makerSprayVerdict, crossValidateFillModel, report

report(res, args, log): Void
  Purpose: F-009. Print fork-equality, fill rate, the binding filled-net-EV CI, the AS diagnostic, Brier-vs-market,
           the zero-skill MC P(PASS), per-station, the spray-protocol by-product, coverage + tz-skew caveats,
           cross-val agreement, and the two-branch WO-5 verdict template (OPEN vs FALSIFIED, Pass-1 L2).
  Called by: run      Calls: makerSprayVerdict (for the printed line)
```

## 7. Data Models (read-only query contracts)
No new tables. Reads (all existing): `market_events`(id, icao_at_creation, city_id→`cities`(slug, region, **tz**),
target_date `[station-local]`, unit, winning_bucket_idx, ladder_ok); `market_buckets`(id, event_id, bucket_idx,
low_native, high_native, fee_rate, tick_size, min_order_size); `market_snapshots`(bucket_id, captured_at,
best_bid, best_ask, mid, **last_trade**) — FULL SERIES; `forecast_snapshots`/`observations`/`config` (db1
loaders, verbatim). `MakerSnapshot`/`RestingBid` are in-memory only; no persistence.

## 8. Interface Contracts

### 8.1 Read-only SQL contracts
```
C-1  EMOS spine (events+ladders+obs+forecast+config) — IDENTICAL to db1; FORK VERBATIM.  Maps to: assembleBids
C-2  Full bucket book series (THE ONE NEW QUERY; tz-correct, Pass-1 C2)
  SELECT mb.event_id, mb.bucket_idx, ms.captured_at, ms.best_bid, ms.best_ask, ms.mid, ms.last_trade
  FROM market_snapshots ms
  JOIN market_buckets mb ON mb.id = ms.bucket_id
  JOIN market_events  me ON me.id = mb.event_id
  JOIN cities         c  ON c.id  = me.city_id
  WHERE me.ladder_ok AND me.winning_bucket_idx IS NOT NULL
    AND me.icao_at_creation = ANY($1) AND me.target_date >= $2 AND me.target_date <= $3
    AND ms.captured_at >= ((me.target_date::timestamp - ($4||' days')::interval) AT TIME ZONE c.tz)  -- lookback, per-city
    AND ms.captured_at <  ((me.target_date::timestamp + interval '2 days')      AT TIME ZONE c.tz)  -- superset past local resolution
  ORDER BY mb.event_id, mb.bucket_idx, ms.captured_at ASC
  Auth: n/a (script DB role, read-only)   Maps to: loadBucketSeries
  Index: served by market_snapshots_bucket_time_idx (bucket_id, captured_at DESC) — confirmed 0004_markets.sql:84-85;
         a DESC index serves an ASC range scan equally (Pass-1 I5 / Pass-2)
  NOTE: the SQL window is a per-city-correct SUPERSET; assembleBids computes the PRECISE resolution/entry instants
        in TS via localDayWindow(c.tz, target_date) and filters the series — the SQL never uses (target_date±1)::timestamptz.
```
### 8.2 Internal module contract
`simulateSpray(bids,opts)→MakerSprayReport` (§6.1) · `makerSprayVerdict(report,opts)→MakerSprayVerdict` (§6.1) ·
`run(args,{db,log})→MakerSprayResult` (§6.2).
### 8.3 CLI contract
```
COMMAND  pnpm tsx scripts/research/maker-spray-feasibility.ts
  Flags: --from (def 2026-04-21) --to (def 2026-06-21) --leads 1,2 --stations EHAM,EGLC
         --rest-at bid|bid+tick|ask-offset (def bid → internal 'bid'|'bid_plus_tick'|'ask_offset', Pass-1 L1)
         --ask-offset 0.07 --fill-model ask_touch|last_trade (def ask_touch) --entry-lead-h 24[,43] (CSV → sweep)
         --lookback-days 3 --cheap-max 0.25 --maker-rebate 0 --margin 0.02 --mc-iters 1000 --cross-val --json
  Inputs: read-only DB (+ optional public /activity crawl for --cross-val)
  Outputs: stdout readout + verdict + spray-protocol + coverage/tz caveats; JSON when --json
  Maps to: §6.2 run / report
```

## 9. Data Flow Diagrams
**Happy path:**
```
CLI → loadEnv + makeScriptDb
  → C-1 loaders (fork) → forecast/obs/event/ladder/config + cities.tz
  → C-2 loadBucketSeries → Map<event, Map<bucket, MakerSnapshot[]>>
  → forkEqualityRmse → assert maker fork == db1 fork on this window (Pass-1 W2)
  → assembleBids: per build-day walk-forward fold
        EmosStation → gaussianBucketProbs(μ,σ,ladder) = calibratedP
        resolutionTs = localDayWindow(c.tz, target_date).endUtc ; entryTs = resolutionTs − entryLeadH (ADR-05)
        → RestingBid per (event,bucket) {entryTs, snapshots, marketProbAtEntry, tzOffsetHours} ; accumulate forkRmse
  → simulateSpray(bids):
        per bid: makerEntry [snapshotAtOrAfter(entryTs) → restPrice → eligible? → simulateFill(restPx, postEntry) → if filled grade+EV]
        aggregate: fillRate, filledNetEv (bootstrap CI), filledEdge, adverseSelection (gating sanity),
                   brierVsMarket, zeroSkillMc, perStation (real CIs), coverage{…, maxTzSkewHours}
  → makerSprayVerdict → pooled evCiLo>0 ? (+ descriptors: stationsClearing, zeroSkillPPass<.05, asSuspect)
  → report → stdout (+ JSON)
  → [external] second agent adversarially re-verifies vs the FROZEN criterion (thresholds unmoved)
```
**Edge branches:** no snapshot at/after entryTs → bid dropped (coverage excludes); restPx≥cheapMax → not in study;
empty postEntry → filled:false; fork-equality mismatch → FAIL build (fork wrong); AS not confirmed → verdict
`asSuspect=true`; zero-skill P(PASS)≥.05 → gate not protective, flag; --cross-val low agreement → headline caveated.

## 10. Dependency Map
**Internal:** `maker-spray.ts` → copy-trade.ts (BucketSnapshot, snapshotAtOrAfter/Before), stats.ts (armEdgeStats,
bootstrapMeanCi, meanConfidenceInterval, wilsonInterval, GradedBet), fees.ts (takerFeeTotal), calibration/scores.ts
(brierScore, mulberry32). `maker-spray-feasibility.ts` → maker-spray.ts; db1 EMOS spine (FORK); copytrade-feasibility
loadSnapshots (FORK); gaussian.ts, emos.ts, time.ts (localDayWindow), core/index.ts; scripts/lib/{backfill,script-db,
load-env,polymarket-crawl}.ts. **External:** none new.

## 11. Cross-Cutting Concerns
**11.1 Errors** — pure module never throws (`[]`/NaN-safe). `gaussianBucketProbs` `DistributionError` (σ≤0.2) is
pre-checked + caught-and-`continue`d in assembleBids, exactly as db1 (`:515-521`). Script: DB errors propagate
loudly; `--cross-val` crawl failure degrades to "cross-val skipped". NaN CI → verdict pass:false.
**11.2 Env/Config** — no new env/secret; `loadEnv` (DB URL); `--cross-val` reuses keyless public Polymarket hosts.
**11.3 Naming** — house idiom: `kebab-case.ts`, `camelCase` verb-first, `PascalCase` types, `SCREAMING_SNAKE`
constants; mirror `copy-trade.ts`/`db1`.

## 12. Extensibility
New `FillModel`/`RestRule` → a union member + a `simulateFill`/`restPrice` branch (downstream is agnostic). A
depth-aware fill model can use `book_top3` jsonb. A "rest at the mid" sharp-reference comparator → add `midAtEntry`
to `RestingBid` (deferred — dropped from v1 to avoid an unwireable field, Pass-1 I3). Persisting the result → a
new migration + `--persist` mirroring `wallet-forensics` `0050` (out of scope; read-only).

## 13. Risk Register
| ID | Risk | Sev | Mitigation |
|---|---|---|---|
| R-1 | Fill model bias mis-stated (ask-touch is *expected*-pessimistic, not proven). | HIGH | ADR-03 (claim softened); the AS diagnostic is a GATING SANITY (`asSuspect` flag); `--fill-model last-trade` + F-008 cross-val quantify; queue-priority caveat stated. |
| R-2 | **Station-local→UTC timezone skew** (was the headline risk). | HIGH→mitigated | ADR-05: `localDayWindow(c.tz, target_date)` for the precise instant + `AT TIME ZONE c.tz` superset SQL; NEVER db1's `(target_date±1)::timestamptz`; report prints `maxTzSkewHours`; `--entry-lead-h` sweep tests sensitivity. |
| R-3 | Fork drift (forked EMOS ≠ live model). | HIGH | `forkEqualityRmse` asserts byte-equality to a LIVE db1 run on the identical window (Pass-1 W2), not the frozen literal; FAIL the build otherwise. |
| R-4 | AS diagnostic mis-computed (filled vs all denominator). | MED | Unit-test on a hand-built series where the only filled bid is a known loser → filledHit=0, allHit>0. |
| R-5 | Sparse far-from-resolution coverage. | MED | `coverage{nWithBook,nWithPostEntrySeries,maxTzSkewHours}` surfaced; headline lead is ~24h (dense, forward-capture-audit 100%); `--lookback-days`/`--entry-lead-h` bound it. |
| R-6 | `last_trade` side-blind (a BUY print ≤ restPx ≠ a fill of OUR bid). | LOW | VARIANT only; documented as an upper bound; ask-touch is the headline; lives on script-local MakerSnapshot (Pass-1 C1). |
| R-7 | False PASS from noise. | MED | Binding gate = POOLED CI>0 (Pass-1 W4); ≥2-stations/not-EHAM are descriptors not gates; MANDATORY zero-skill MC <5%; per-station min-n≥20; external second-agent re-verify. |
| R-8 | Accidental `packages/trading` coupling. | LOW | §15 invariants test forbids it (but allow-lists `*.test.ts` — Pass-1 I2 — so the test file self-disciplines); module imports only core siblings. |
| R-9 | `last_trade` column assumed but absent. | LOW | Confirmed present `0004_markets.sql:76` (Pass-1 verified); a checklist item re-asserts before trusting the variant. |

## 14. Implementation Roadmap (this IS the build Workflow's phase plan)
- **P0 — Pure core `maker-spray.ts` first slice.** `restPrice`, `simulateFill` (ask_touch + last_trade), `makerNetEvPerDollar`,
  `makerEntry`, `simulateSpray` (incl. AS diagnostic, Brier-vs-market, zero-skill MC, per-station real CIs),
  `makerSprayVerdict`, `crossValidateFillModel` + `maker-spray.test.ts` (deterministic; `[]`/NaN-safe; the R-4
  known-loser AS test; a known-fill/known-no-fill series test; a zero-skill-MC-calibration test). *DoD:* `pnpm
  typecheck && pnpm test` green; the fill model + verdict proven in isolation, no DB.
- **P1 — Script spine: forks + tz-correct full-series load + assemble.** `loadBucketSeries` (C-2), the forked EMOS
  spine (db1) + `loadSnapshots` (copytrade), `assembleBids` with `localDayWindow` resolution/entry + the forkRmse
  accumulator, `forkEqualityRmse`. *DoD:* on the real DB, `forkEqualityRmse.equal === true` vs a live db1 run on
  the same window (R-3); `RestingBid[]` non-empty; `maxTzSkewHours` reported per the corrected window.
- **P2 — Wire study + report + verdict + variants.** `run` + `report`; `--rest-at`/`--fill-model`/`--entry-lead-h`
  sweep with verdict-stability assertion (M1); coverage + tz-skew caveat block; spray-protocol by-product; the
  two-branch WO-5 verdict template. *DoD:* runs end-to-end; prints binding CI + AS + Brier + zero-skill P(PASS) + verdict.
- **P3 — Cross-validation.** `crossValidateFillModel` + `--cross-val` crawl (reuse `polymarket-crawl.ts`). *DoD:*
  prints agreement rate on badatmath's real cheap fills; degrades cleanly on rate-limit.
- **P4 — Run + adversarial verify + record.** Run default + the entry-lead/fill-model robustness sweep; a SECOND
  agent adversarially re-verifies the verdict vs the FROZEN criterion (pooled CI clears 0? zero-skill <5%? AS
  confirmed? thresholds unmoved?); append `WALLET-RECON-HANDOFF.md` §12 + write memory. *DoD:* number + adjudicated
  verdict recorded; nothing shipped to prod.

Pipeline: P0 ‖ P1 → P2 → (P3 ‖ report) → P4.

## 15. Build Verification Checklist
### Module: maker-spray.ts (pure)
- [ ] `restPrice` — bid / bid_plus_tick / ask_offset, tick-rounded DOWN, null on unusable
- [ ] `simulateFill('ask_touch')` — filled iff min(best_ask)≤restPx; minAskAfter/fillIdx correct; empty→false; non-finite skipped; never throws
- [ ] `simulateFill('last_trade')` — operates on FillSnapshot.lastTrade (script-local MakerSnapshot), not the imported BucketSnapshot (Pass-1 C1)
- [ ] `makerNetEvPerDollar` — win/loss P&L + takerFeeTotal; `max(0, fee − rebate·shares)`; NaN on bad px; it is a NEW fn, not a reuse
- [ ] `makerEntry` — SOLE entry-snapshot owner (snapshotAtOrAfter(entryTs)); eligibleCheap gate; grades only when filled
- [ ] `simulateSpray` — fillRate, filledNetEv (bootstrap CI seed 42), filledEdge, perStation as REAL CIs
- [ ] `simulateSpray` — AS diagnostic filledHit vs allEligibleHit (R-4 known-loser test) + `asConfirmed`
- [ ] `simulateSpray` — `brierVsMarket` (brierScore vs market-implied-at-entry, F-006) present + correct
- [ ] `simulateSpray` — `zeroSkillMc` shuffles `won` within station, re-verifies ~1000×, reports P(PASS) (ADR-08/W4)
- [ ] `simulateSpray` — empty/all-ineligible → zeroed report, never throws
- [ ] `makerSprayVerdict` — BINDING gate = pooled filledNetEv.evCiLo>0; READS per-station evCiLo (no armEdgeStats re-stat, Pass-1 W5); NaN→false; `asSuspect`/`zeroSkillPPass` surfaced; ≥2-stations/EHAM are descriptors
- [ ] determinism — two runs byte-identical (seeded mulberry32); input arrays SQL-ordered (Pass-1 I6); all pure fns `[]`/NaN-safe
- [ ] imports — only ./copy-trade.ts, ./stats.ts, ../fees.ts, ../calibration/scores.ts; NO packages/trading (incl. the test file, Pass-1 I2/R-8)
- [ ] `crossValidateFillModel` — agreement over predicted-filled; empty → NaN/0

### Module: maker-spray-feasibility.ts (script)
- [ ] `loadBucketSeries` (C-2) — full ascending MakerSnapshot series incl. last_trade; tz-correct `AT TIME ZONE c.tz` superset window; missing→absent
- [ ] forked EMOS spine — IDENTICAL forecast/obs/event/ladder maps to db1 (no shared-harness edit); `loadSnapshots` forked from copytrade
- [ ] `assembleBids` — fold mirrors db1; calibratedP via gaussianBucketProbs; resolutionTs=localDayWindow(c.tz,target_date).endUtc, entryTs=res−leadH (ADR-05); does NOT resolve the entry snapshot (makerEntry owns it)
- [ ] `forkEqualityRmse` — asserts byte-equality to a LIVE db1 run on the identical window/scope (Pass-1 W2), NOT the frozen 1.2991 literal
- [ ] `run` — load→assemble→forkEquality→simulateSpray→verdict→(opt)crossVal; entry-lead/fill-model SWEEP asserts verdict stability (M1); read-only
- [ ] `report` — fork-equality, fill rate, BINDING filled-net-EV CI, AS diagnostic, Brier-vs-market, zero-skill P(PASS), per-station, spray-protocol, coverage + maxTzSkewHours caveat, WO-5 two-branch template (Pass-1 L2)
- [ ] CLI — all flags incl. `--rest-at bid|bid+tick|ask-offset` (mapped to internal enum, Pass-1 L1), `--mc-iters`, `--cross-val`, `--json`
- [ ] read-only — no INSERT/UPDATE/DELETE; no migration; no Edge Function
- [ ] shared-harness UNMODIFIED — `git status` clean for db1-daybefore-efficiency.ts / mos-pointskill.ts / copytrade-feasibility.ts / openmeteo.ts / 0010_seed.sql / dash_amsterdam_sim (Pass-1 M3)

### Data / Flows
- [ ] C-2 — ms→mb→me→cities join; ladder_ok + winning_bucket_idx; tz-correct window; ASC; served by (bucket_id,captured_at) index; no write
- [ ] `last_trade` column exists in live schema before trusting the variant (R-9)
- [ ] no new table / migration / cron / web surface
- [ ] Happy path — runs end-to-end on the real DB, prints headline + verdict
- [ ] Edge: no entry snapshot / restPx≥cheap / empty series / fork-equality mismatch / AS-not-confirmed / zero-skill≥5% / all-unfilled — each handled per §9
- [ ] P4 — verdict adversarially re-verified vs the FROZEN criterion (pooled CI; thresholds unmoved); §12 + memory recorded
```
