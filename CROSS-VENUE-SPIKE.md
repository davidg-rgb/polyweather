# Cross-Venue Spike — Kalshi ↔ Polymarket relative value (the 10th signal)

> **What this is.** The one genuinely-orthogonal, forecast-free, *executable* net-profit lever the R&D
> program had never tested. Every prior signal asked "is **our forecast** better than the market?"
> (signals 1–7, 9) or "is **one book** consistent with itself?" (signal 8, complete-set arb). This asks
> the orthogonal question: **do two independent venues price the same day's high differently — beyond
> what it costs to harvest the difference?** It needs zero forecast skill.
>
> **Status (2026-06-25): BUILT + LIVE (forward capture).** Pre-registered, operator-ratified gated
> paper measurement; no capital, the live trading rail stays DORMANT. The verdict renders after ~1 week
> of matched panel. Strong prior from the day-1 NYC read: **lands KILL (fee/offset/basis-walled), like
> the 8th signal** — but it is the only executable orthogonal lever, so it earns one clean measurement.

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

1. **A 1°F bin offset.** Polymarket bins start EVEN (80-81, 82-83…); Kalshi bins start ODD (79-80,
   81-82…) — verified live on both books. Their clean cumulative thresholds **interleave** (Polymarket
   gives P(high≥K) at even K, Kalshi at odd K), so the two venues **never share a constructible
   threshold**. Any cross-venue position carries a ~1°F directional stub. The engine prices that stub
   (`offset`) so the "free" cashflow from selling a broader event than you bought is netted back out.

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

## Reading the verdict

- **Operator dash:** `select dash_cross_venue(7);` — matched days, real-depth days, win fraction, mean
  net edge, per-city divergence, recent captures (jsonb object, `operator_guard`).
- **Full verdict:** `pnpm tsx scripts/research/cross-venue-arb-scan.ts --days 14` — collapses to one
  city-day per (city, target_date) and renders the frozen `crossVenueVerdict`.
- **Reopening trigger:** a non-zero, CI-clean net-positive fraction in the scan → escalate to an executor
  design (and a real depth-walk). Otherwise: KILL, logged as the 10th signal in `FINDINGS.md`.

## Build inventory

| Piece | File |
|---|---|
| Pure engine + frozen gate | `packages/core/src/sim/cross-venue-arb.ts` (+ `test/cross-venue-arb.test.ts`) |
| Kalshi venue parsers | `packages/core/src/kalshi/markets.ts` (+ `test/kalshi-markets.test.ts`) |
| Capture migration | `supabase/migrations/0062_cross_venue_capture.sql` |
| Capture Edge Function | `supabase/functions/cross-venue-capture/{index,handler,pure}.ts` (+ `handler.test.ts`) |
| Verdict scan | `scripts/research/cross-venue-arb-scan.ts` |
| Basis estimator | `scripts/research/cross-venue-basis.ts` |

Tests: +56 across the four new test files; full suite green; typecheck clean.
