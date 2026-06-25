# Cross-Venue Spike — Kalshi ↔ Polymarket relative value (the 10th signal)

> **What this is.** The one genuinely-orthogonal, forecast-free, *executable* net-profit lever the R&D
> program had never tested. Every prior signal asked "is **our forecast** better than the market?"
> (signals 1–7, 9) or "is **one book** consistent with itself?" (signal 8, complete-set arb). This asks
> the orthogonal question: **do two independent venues price the same day's high differently — beyond
> what it costs to harvest the difference?** It needs zero forecast skill.
>
> **Status (2026-06-26): VERDICT = KILL — a CAPACITY WALL (the 10th falsified signal).** The forward
> paper panel + a live both-venue depth verification settled it early and decisively: a real quoted
> cross-venue price gap exists (day-1: 6 of 7 real-depth city-days net-positive, NYC +0.26 / Miami +0.23),
> but the cumulative YES≥k synthetic fills at only **1–10 contracts/shares of TRUE touch depth** on its
> thin tail legs — below any tradable floor — on *every* net-positive city-day, stable across samples. A
> quoted edge that is not capturable money. Same structural-wall destination as the 8th signal (there the
> fee; here touch depth). No capital, rail stays DORMANT. **What this forced:** the original gate scored
> the quoted edge against a 24h-volume/OI **proxy** that would have FALSE-PASSED (winFrac 0.857); it is now
> hardened to require true both-book executable depth (migration **0064** — winFrac over *executable* wins
> = **0 → KILL**). Verification harness: `scripts/research/cross-venue-verify.ts`. See §"The capacity wall".

---

## Why this lever, and why now

Every prior lever died on **"real edge, but unreachable from where we sit."** This one is different on
both counts:

- **It is reachable.** Verified 2026-06-25: **Kalshi went global in 2026 (143 countries) and Sweden is
  supported**; **Polymarket is *not* geo-blocked in Sweden** (the MiCA block hit France/Belgium — Sweden
  runs under reverse-solicitation). Both venues are executable for this operator.
- **The product matches.** The same US city's daily high trades on **Polymarket**
  (`highest-temperature-in-<city>`, resolves on **Wunderground** hourly-obs max, EVEN-start 2°F bins)
  AND **Kalshi** (`KXHIGH<city>`, resolves on the **NWS Climatological Report / CLI**, ODD-start 2°F
  bins). Of the 11 US cities we track on Polymarket, Kalshi lists **6**: **NYC, LA, Chicago, Miami,
  Austin, Denver** (KXHIGHHOU/DAL/ATL/SF/SEA return no market). ≈6 matched city-days/day → ≈40/week.

## Why it is NOT a clean arbitrage — the double basis

Two structural frictions stand between "the prices differ" and "you can lock a profit". The whole
measurement is whether the cross-venue price gap ever clears **both**:

1. **A 1°F bin offset — but only for SOME cities (premise corrected 2026-06-26).** Polymarket bins start
   EVEN (80-81, 82-83…). Kalshi's parity is **city-dependent**, not universally odd as first stated:
   live, **NYC is odd-start** (79-80, 81-82…) — a real 1°F offset — but **Miami/LA/Denver are EVEN-start**
   (90-91, 92-93… / 70-71, 72-73…) = the *same* grid as Polymarket, so those venues **DO share clean
   thresholds** (the engine confirms `expPayoff = 0` there). For the offset cities the engine prices the
   ~1°F directional stub (`offset`) so the "free" cashflow from selling a broader event than you bought is
   netted back out; for the aligned cities the cross-venue gap is a direct same-threshold comparison.

2. **A dual resolution source.** NWS CLI is QC'd and runs **≥ Wunderground** (occasionally +1°F —
   `research/REPORT-weather-data.md §d`). So even a bin-aligned position is **not market-neutral**: the
   two legs can resolve on opposite sides of a threshold. The engine charges this via a `BasisModel`
   (the δ = CLI − WU distribution).

These are the **prime suspects** for why this "arb" is likely already dead — the price gap may be
**correctly-priced basis, not free money**. The same shape as the 8th signal: a real inconsistency
swallowed by a structural cost wall (there, the taker fee).

## The first measurement (NYC, 2026-06-25)

| Integer high | Polymarket bin (mid) | Kalshi bin (mid) |
|---|---|---|
| 80°F | 80-81 → 0.16 | 79-80 → 0.11 |
| 81°F | 80-81 → 0.16 | 81-82 → **0.60** |
| **82°F** | 82-83 → **0.59** | 81-82 → **0.60** |
| 83°F | 82-83 → 0.59 | 83-84 → 0.33 |
| 84°F | 84-85 → 0.205 | 83-84 → 0.33 |

Both venues put the mode on the bin **containing 82°F at ~0.60** (Kalshi 81-82 = 0.60; Poly 82-83 =
0.59) — they agree on the modal high to within ~1¢ once you account for the offset. **No glaring free
money.** The residual tail differences are within overround + basis. This is what motivates a *measured*
panel, not an eyeball.

## The engine (`packages/core/src/sim/cross-venue-arb.ts`, pure + tested)

1. **`impliedLadder`** — reconstruct each venue's implied per-integer-°F PMF by spreading each bucket's
   normalized mid mass uniformly across its integers (this **removes overround**, isolating the
   distribution shape for a like-for-like comparison).
2. **`crossVenueDivergence`** — the descriptive analytics signal (always exists, even with no profit):
   the signed survival gap S_poly(k) − S_kalshi(k) at every threshold, the KS-style max, and the implied
   mean-temperature difference.
3. **`crossVenueEdge`** — the executable, basis-adjusted edge. For each constructible threshold and both
   directions: `netEdge = cashflow + E[long pays] − E[short owes]`, where the cashflow uses raw
   bid/ask + both fee curves (Polymarket 0.05·p·(1−p), Kalshi 0.07·p·(1−p)) and each leg's expected
   resolution payoff is valued under a **neutral WU consensus** (Polymarket's WU PMF averaged with
   Kalshi's CLI PMF de-shifted to WU terms by the basis). This makes a single-venue round-trip net to
   −spread−fee (no phantom edge) and prices the offset stub + the dual-source basis correctly. A
   positive `netEdge` is therefore a **genuine cross-venue dislocation beyond fees, offset, and basis**.
   - *Honest limit:* comparing offset 2°F ladders has an irreducible ~1-bin sub-bin-interpolation noise
     floor (a few pp, unbiased). A single snapshot can show small noise of either sign; the gate's
     CI-excludes-0 requirement is what filters it.

## The FROZEN kill gate (operator-ratified 2026-06-25)

> An **executable, basis-adjusted, fee-cleared** cross-venue position must show **positive expectancy on
> ≥10% of matched city-days that have real depth**, with the **pooled 95% CI of the mean net edge
> excluding 0**. Else **KILL — the 10th falsified signal**, the same structural-wall destination as the
> 8th. The live rail stays DORMANT.

Defined by the economics (WO-5 discipline), not fitted to a result. `MIN_PANEL_DAYS = 12` real-depth
city-days before a non-`INSUFFICIENT_DATA` verdict. `MIN_DEPTH_SHARES = 20` (the "real depth" floor).

## How the panel is captured (forward — there is no historical Kalshi book)

`cross-venue-capture` Edge Function (migration **0062**, cron `*/30`): each tick fetches **both** order
books **contemporaneously** — Polymarket via Gamma top-of-book, Kalshi via its keyless market-data API —
for the 6 overlap cities, runs the engine, and appends one row per matched city-day to
`cross_venue_captures`. Read-only against both venues; no orders.

- **Depth (v1):** top-of-book edge with a liquidity **proxy** — Kalshi per-bin open interest, Polymarket
  per-bucket 24h volume. A net-positive day would trigger a **true CLOB/orderbook depth-walk** before any
  capital (the executor-design step). The orderbook parser (`parseKalshiOrderbook`) is built and tested
  for that seam.
- **Basis (v1 = NEUTRAL):** the live capture measures the **pure price dislocation** with a basis-neutral
  model (`NEUTRAL_BASIS`, CLI = WU), **not** the CLI-hot prior. The first 6-city panel (2026-06-25)
  showed an unverified CLI-hot prior *manufactures* a systematic buy-Kalshi edge even when the venues'
  implied means agree to <1°F (the CLI premium is already in Kalshi's price AND re-credited in the
  expected payoff → double-counted). Neutral is the conservative kill-gate stance (won't false-PASS);
  `scripts/research/cross-venue-basis.ts` + the realized (CLI − WU) from settled outcomes refine it, and
  a basis-driven edge is only believed once the realized basis confirms it. `DEFAULT_BASIS_PRIOR` stays
  in the engine for that basis-aware re-analysis.

### Two engine refinements the live data forced (2026-06-25)

The first capture over all 6 cities surfaced — and verified the fix for — two robustness issues:

1. **Open-tail mass distortion (the Denver lesson).** On a cool day Kalshi priced 83% on "74° or below";
   spreading that mass uniformly to the grid floor (20°F) dragged the implied mean to ~53°F and faked a
   **21°F divergence + a phantom edge** — when both venues in fact agreed the high was ~73-74°F. Fix:
   `TAIL_SPREAD_F` concentrates an open tail's mass within 3°F of its boundary. Denver now reads
   poly 73.73 / kalshi 73.81 (−0.08°F) — agreement, no phantom.
2. **Basis-prior directional bias** → the neutral-basis decision above.

After both: all 6 cities agree on the implied mean to **<1°F**, the day-1 read is **agreement, not edge** —
the strong-prior **KILL** is intact, now measured cleanly.

## The capacity wall — why it KILLs (verdict 2026-06-26)

The day-1 panel did **not** read as agreement. Across the 6 cities it showed **6 of 7 real-depth
city-days net-positive** — NYC **+0.26**, Miami **+0.23**, persistent across ticks. On the original
24h-volume/OI depth **proxy** that is winFrac **0.857** → a screaming (and **false**) PASS. The strong
prior said KILL, so the trend was investigated before the panel could render, with a live both-venue
verification (`scripts/research/cross-venue-verify.ts` — re-runs the pure engine against live books AND
walks the TRUE order book on **both** venues at the touch):

1. **The edges are real quoted gaps, not noise** — reproduced across ticks and across an independent
   live re-fetch; driven by a standing ~1°F inter-venue mean disagreement. (Not sub-bin reconstruction
   noise either — NYC's cashflow exceeds the *maximum* P(offset integer) a 2°F bin can hold.)
2. **…but not capturable money.** Harvesting the gap means constructing the cumulative YES≥k synthetic on
   both venues, and that synthetic is throttled by its **thinnest leg** — the thin TAIL bins. TRUE touch
   depth: **NYC 36–72, Miami 6, LA 5, Denver 5–6 contracts/shares** — `min` over both books, stable across
   samples. The proxy overstated executable capacity by **1–3 orders of magnitude**.
3. **The biggest raw edges are same-day running-max LATENCY** (the WO-5 effect — Polymarket's Wunderground
   running max already sees today's high while Kalshi's CLI book lags), not the cross-venue forecast thesis.

**The gate fix (migration 0064).** A WIN now requires `is_executable` — the binding both-book touch depth
≥ `MIN_EXEC_SIZE` (=25), walked live for net-positive rows in the capture handler (STEP 3.5) — **not** the
volume proxy. `has_real_depth` stays the proxy DENOMINATOR (else it collapses to 0 and the verdict
deadlocks at INSUFFICIENT_DATA). Live result: **winFrac 0/7 → KILL.** The rail stays DORMANT.

## Reading the verdict

- **Operator dash:** `select dash_cross_venue(7);` — now reports `netPositiveDepthDays` (QUOTED) vs
  `executableWinDays` (REAL), `winFrac` over executable wins, and `maxExecSize` (the capacity wall in
  units). jsonb object, `operator_guard`.
- **Full verdict:** `pnpm tsx scripts/research/cross-venue-arb-scan.ts --days 14` — collapses to one
  city-day per (city, target_date); the report shows the quoted-vs-executable split and renders the
  frozen `crossVenueVerdict`.
- **Live depth check:** `pnpm tsx scripts/research/cross-venue-verify.ts [--rounds 3]` — one-shot both-
  venue executable-capacity probe (the harness that settled the verdict).
- **Reopening trigger:** an `executableWinDays > 0` with a CI-clean positive fraction → escalate to an
  executor design + a full depth-walk. Otherwise it stays the 10th falsified signal in `FINDINGS.md`.

## Build inventory

| Piece | File |
|---|---|
| Pure engine + frozen gate + **executable-depth gate** (`bindingExecutable`, `MIN_EXEC_SIZE`, leg exposure on `CrossVenueEdge`, `executable` on `PanelDay`) | `packages/core/src/sim/cross-venue-arb.ts` (+ `test/cross-venue-arb.test.ts`) |
| Kalshi venue parsers + orderbook walker | `packages/core/src/kalshi/markets.ts` (+ `test/kalshi-markets.test.ts`) |
| Capture migration | `supabase/migrations/0062_cross_venue_capture.sql` |
| Dash real-depth headline fix | `supabase/migrations/0063_cross_venue_dash_realdepth.sql` |
| **Executable-depth gate migration** (`exec_size` + `is_executable`; winFrac over executable wins) | `supabase/migrations/0064_cross_venue_executable_depth.sql` |
| Capture Edge Function (+ STEP 3.5 both-book depth walk; pure `executableLegSpecs`) | `supabase/functions/cross-venue-capture/{index,handler,pure}.ts` (+ `handler.test.ts`) |
| Verdict scan (quoted-vs-executable split) | `scripts/research/cross-venue-arb-scan.ts` |
| **Live both-venue capacity verification harness** | `scripts/research/cross-venue-verify.ts` |
| Basis estimator | `scripts/research/cross-venue-basis.ts` |

Tests: full suite **1483 green**; typecheck clean. The executable-depth gate adds `bindingExecutable` +
verdict executable-gating + `executableLegSpecs` mapping + the capacity-wall DB test (a net-positive but
non-executable row is quoted, NOT a win).
