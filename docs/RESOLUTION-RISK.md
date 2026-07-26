# RESOLUTION-RISK — WU-independent truth cross-check, per city (CITY-ORACLE-BUILDOUT Build 2)

> **2026-07-25.** The decoded resolution oracle (`docs/DATA-SOURCES.md` §resolution-oracle, validated
> 66/66) claims WU's Daily Observations table is a bit-for-bit METAR/SPECI re-render. This build grades
> that claim against our own stored grading truth, city by city, and turns the residual into a per-city
> **resolution-risk** number — plus a market-winner adjudication of every disagreement. Analytics only:
> **grading is untouched (ADR-04: WU integers are never re-derived in grading), no trading implication.**

## Method

1. **Stored truth:** `observations.tmax_wu_native` (provenance `wu`, finalized, not provisional),
   trailing ~95 days — pulled read-only to `scripts/research/out/wu-truth-90d.json` (SQL in the
   `truth-replica-crosscheck.ts` header). Window graded: **2026-04-21 .. 2026-07-25** (n = 4,288
   city-days, 45 cities).
2. **Replica:** per city-day METAR/SPECI daily max from the IEM archive
   (`out/iem-asos-archive/`, `iem-backfill.py`), rendered with the **exact same code path** the
   floor-formation climatology uses (`renderRow`/`buildStationDays` in `city-floor-climatology.ts` —
   `wuRound` of the native unit, station-local-day bucketing; zero drift by construction).
3. **Metric:** per city, `matchRate` = share of joined days where replica == stored WU;
   **resolution-risk = 1 − matchRate**.
4. **Adjudication (the decisive extra):** for every MISMATCH day with a resolved market in the local
   `out/market-history/` archive, check which value lands inside the market's actual winning bucket —
   replica-only / wu-only / both (uninformative: wide bucket covers both) / neither.

Run: `pnpm tsx scripts/research/truth-replica-crosscheck.ts --emit packages/core/src/sim/resolution-risk.ts`

## Headline result

**Overall agreement 4,170 / 4,288 = 97.25%.** 30 of 45 cities are at exactly 100%. The residual is TWO
distinct mechanisms with opposite implications:

### Mechanism 1 — shenzhen: WU's page is NOT a ZGSZ METAR re-render (replica-side risk, 77%)

| | |
|---|---|
| match rate | **22.9%** (n=96) — off-by spread −2..+2, both directions, `other` tails |
| market-winner adjudication | **57 resolved mismatch days: WU matches the winner 46, replica 2, both 1, neither 8** |

The market resolves with WU, decisively — so for shenzhen the METAR replica is simply the wrong
instrument: WU renders a different feed/station than ZGSZ's disseminated METARs. (The deep-history
validation flagged shenzhen with 16 divergences; this pins it at scale.) **Grading is unaffected**
(grading reads WU). The consequence is for ANALYTICS: any replica-derived product (floor-formation
climatology, kill replays, Build 3's floor curves) is untrustworthy for shenzhen. The `/cities` strip
now carries this as a red "replica agrees 23%" cell.

Seoul — the other deep-history hotspot — is mild by comparison: 95.8%, ±1 both ways, adjudication
1 replica / 2 wu. A small WU-side quirk, not a broken instrument.

### Mechanism 2 — °F cities: the STORED truth misses the resolved value on ~1–2% of days (truth-side risk)

Every °F city shows a small, **strictly one-sided** divergence — the replica reads **+1..+2°F higher**
(denver/houston/miami 6.3%, austin/dallas 4.2%, sf/seattle 3.2%, la 2.1%) — while °C cities sit at
~100% (the °C coarsening swallows sub-degree peaks). On the mismatch days where the resolved winner
bucket discriminates between the two values:

> **Excluding shenzhen: replica matches the winner 17, stored WU 4, both 21 (uninformative), neither 0.**

So when our WU-API-derived truth and the METAR stream disagree on a °F city-day, the market's actual
resolution sided with the **METAR replica 17-to-4**. Shape of the miss (convective/SPECI-heavy cities,
always replica-higher) is consistent with WU's v1 API obs missing brief SPECI peaks that the History
table (and hence resolution) includes — hypothesis, not proven; the adjudicated direction is proven.

**Implication (analytics, small but real):** `observations.tmax_wu_native` under-reads the actual
resolution value on roughly 1–2% of °F city-days. For /data-style accuracy trends this is noise-level
(±1°F on ~1 day in 60), but it is a real bias in the strict sense, and it means "we were graded wrong"
days exist at low rate in the °F panel of any truth-scored analytics.

## The committed asset + surface

- `packages/core/src/sim/resolution-risk.ts` — per-city `{n, matchRate, resolutionRisk,
  meanSignedDiff}`, window-stamped, regenerable by the one command above (tests:
  `packages/core/test/resolution-risk.test.ts` pin the structural invariants + the two adjudicated
  facts).
- `/cities` → the "When is the day decided?" table now includes a **replica agrees** column
  (red under 90%); full detail JSON in `scripts/research/out/truth-replica-crosscheck.json`.

## Proposal (operator-gated — NOT applied)

Two candidate design changes fall out of Mechanism 2; both touch the truth layer, so per ADR-04 and
the handoff they are **proposals only**:

1. **Truth-hardening flag:** when the replica and stored truth disagree on a finalized day, record a
   `divergence_flags` entry (the column already exists on `observations`) so truth-scored analytics
   can exclude/flag those days instead of silently absorbing a known-wrong truth value.
2. **Replica as the IEM-daily fallback replacement:** the current sparse-WU fallback
   (`iem_fallback`, §7.7 — IEM *daily* endpoint, a non-resolution quantity) could be replaced by the
   per-ob METAR replica max (the validated resolution-grade quantity). Strictly better fallback, but
   it changes grading provenance → operator decision.

Neither is needed for any live surface today; both are cheap if the operator wants them.

## The "resolution-noise smearing" stretch test — NOT RUNNABLE AS DESIGNED (adjudicated 2026-07-26)

The handoff's stretch item (add a per-city resolution-noise term to bucketization for
high-divergence cities; pre-registered OOS Brier test) presupposed that divergence is *noise* spread
across cities. The measured structure is neither: (a) **shenzhen** is the only high-divergence city
and its divergence is not noise — it is a broken replica instrument (WU renders a different feed
entirely; adjudication 46:2 against the replica), so no smearing term derivable from ZGSZ METARs can
model it; (b) the °F-city divergence is **truth-side** (our stored value misses the resolved one),
which a forecast-side noise term cannot address; and (c) every other city sits at 96–100% agreement,
leaving nothing to smear. A one-city, 96-day panel also has no power against a day-clustered OOS
gate. Closed without running — the honest verdict is that the premise, not the execution, fails.

## Caveats

- 90-day window; regen quarterly-ish (with the truth SQL + `--emit`) to keep the /cities column honest.
- °C cities' ~100% partially reflects rounding coarseness, not a cleaner pipeline — the °F panel is
  the sensitive instrument.
- The adjudicator only exists where a market resolved (98 of 118 mismatch days); "both" rows are
  uninformative by construction (wide winner buckets).
- IEM archives *corrected* METARs — a late correction that WU's freeze rule ignored is a residual
  divergence channel (rare; would show as replica≠WU with the market siding with WU, which outside
  shenzhen was observed 4 times total).
