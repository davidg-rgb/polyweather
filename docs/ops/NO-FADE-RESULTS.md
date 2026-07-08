# NO-FADE — the negative side of the convergence play (2026-07-08, operator-directed)

**Question (operator):** across all cities, match our predicted outcome ±3 degrees and simulate the convergence
play on the **NO** side — buy NO at 50–70¢, sell at >80¢. Is there an edge on the negative side?

**Verdict: NO. It loses money robustly on every variant — §9R-E KILL with entirely-negative confidence
intervals (not even "noise straddling zero" — a genuine, measured loss).** The market prices the NO side as
efficiently as the YES side, and buying NO at 50–70¢ self-selects into exactly the buckets most likely to
actually win (adverse selection). Engine: `scripts/research/no-fade.ts` (real book, city-clustered gate).

## Setup

- **Universe:** all resolved daily-Tmax markets, both units — **1,077 markets / 45 cities / 26 days**.
- Buckets are 1°/1°F wide, so "±3 degrees" = **±3 bucket indices** of our house-blend predicted bucket.
- **NO price = complement of the stored YES top-of-book:** buy NO at `1 − best_bid`, sell NO at `1 − best_ask`
  (the taker fee `rate·p·(1−p)` is symmetric in p↔1−p).
- **Entry:** first tick where NO ask ∈ [0.50, 0.70] (== YES best_bid ∈ [0.30, 0.50]). **2,766 positions entered.**
- **Exit (FLIP, the ask):** maker-sell NO at 0.80 when the NO bid reaches it; if never, dump at the last NO bid.
- **HOLD reference:** NO pays $1 if the bucket does NOT win (i.e. `bucket_idx ≠ winner`).
- **Gate:** one net-return row per **market** (a market's ±3 NO bets are one correlated portfolio — per-bucket
  rows would pseudo-replicate), through the frozen `openingVerdict` (city-clustered 95% CI + zero-skill sign-flip
  MC + day-block tightening).

## Result — by distance from our predicted bucket

| dist | n | NO-win% | flip-done% | flip net | flip ROI | hold net | hold ROI |
|---|---|---|---|---|---|---|---|
| 0 (fading our own pick) | 928 | 64.1% | 59.4% | −$1995 | **−21.5%** | −$530 | −5.7% |
| 1 | 1260 | 67.4% | 63.3% | −$2110 | **−16.8%** | −$153 | **−1.2%** |
| 2 | 459 | 65.6% | 60.1% | −$866 | −18.9% | −$176 | −3.8% |
| 3 | 119 | 61.3% | 54.6% | −$264 | −22.2% | −$105 | −8.9% |

## Result — the §9R-E gate (per-market portfolios, city-clustered)

| variant | markets | raw ROI | §9R-E | city-clustered mean | 95% CI | verdict |
|---|---|---|---|---|---|---|
| FLIP · all ±3 | 1077 | −18.9% | KILL | −21.9% | [−24.0%, −19.8%] | decisive loss |
| FLIP · neighbors 1–3 | 1060 | −17.6% | KILL | −20.5% | [−23.5%, −17.6%] | decisive loss |
| HOLD · all ±3 | 1077 | −3.5% | KILL | −6.6% | [−8.4%, −4.7%] | decisive loss |
| **HOLD · neighbors 1–3** | 1060 | −2.4% | KILL | −5.9% | **[−9.3%, −2.5%]** | decisive loss |

Every CI is **entirely below zero** — unlike the °C 20¢-YES-hold (C10, CI straddled 0), this is not a marginal
noise call, it is a robustly-measured negative edge. zsMC 2.7–3.2% (<5%) throughout.

## Why it loses (the mechanism)

1. **Adverse selection at entry.** A bucket's NO is only 50–70¢ (YES 30–50¢) *because the market rates it a
   contender.* So the buckets you can buy NO on cheaply are precisely the ones most likely to actually win — the
   NO-win rate on *entered* positions is only 61–67%, far below the ~90% you'd get NO-ing random far buckets.
   You're systematically fading the buckets hardest to fade. (This is the NO-side twin of the YES-side adverse
   selection that killed maker-spray/copy-trade.)
2. **The flip caps the upside, keeps the downside** (same mechanism that killed the °F/°C YES flip, C7). Selling
   at 80¢ caps a 60¢ NO entry's gain at ~+20¢; but only ~60% of positions ever reach 80¢, and when the bucket
   *wins*, NO crashes toward $0 and dumps at a big loss. Flip (−20%) ≫ worse than hold (−6%).
3. **Even HOLD loses** (−6%): with the YES side efficiently priced, its NO complement is too; after the taker
   entry fee and the adverse selection above, NO-hold nets a few points negative. The market prices the near-mode
   buckets' win probability correctly.

## Caveats (honest)

- **Top-of-book only.** `market_snapshots` has no NO-side depth, so this uses `1 − best_bid/ask` (top of book).
  True executable NO depth (walking the book) can only make it **worse** — the KILL holds a fortiori (the
  quoted-vs-executable gap that false-passed cross-venue).
- **Beyond ±3 not separately gated.** Tail buckets (>3 from mode) sit deep-NO (>80¢ already) and rarely enter the
  50–70¢ band, so the near-neighborhood *is* the tradable NO universe for this price band. Confirmed by the entry
  counts thinning at dist 3 (n=119).

## Bottom line

The NO-fade is the **mirror image of the (already-dead) YES convergence play, and it dies the same way — plus an
extra flip penalty.** No tradable edge on the negative side, in any city, at 50–70¢ → 80¢. Consistent with all 12
dead signals + WS-A: the book is efficient in both directions. Engine kept (`no-fade.ts`) — it will catch a NO
edge if one ever appears forward, but the strong prior (now measured) is that none exists.

---

## Buy × Sell GRID (operator follow-up) — every combination loses, no profitable cell

Swept the full entry-band × exit-target surface (`scripts/research/no-fade-grid.ts`, 478,640 ticks / 1,084
markets, all ±3 buckets). Cell = **city-clustered mean net-return** through `openingVerdict`; a robustly-profitable
cell needs **ciLow > 0**.

**FLIP grid** (buy NO in band ↓, maker-sell NO at target →; dump at last bid if never reached):

| buy \ sell | 70¢ | 75¢ | 80¢ | 85¢ | 90¢ | 95¢ | **HOLD** |
|---|---|---|---|---|---|---|---|
| **35¢** | −46.7% | −44.7% | −42.3% | −40.1% | −38.6% | −37.6% | −11.6% |
| **45¢** | −42.3% | −41.2% | −39.6% | −38.5% | −37.0% | −36.1% | −14.1% |
| **55¢** | −30.6% | −31.3% | −31.2% | −30.6% | −29.4% | −28.8% | −9.5% |
| **65¢** | — | −20.5% | −21.4% | −21.9% | −21.3% | −21.2% | −6.4% |
| **75¢** | — | — | — | −16.7% | −16.7% | −17.2% | −5.4% |
| **85¢** | — | — | — | — | — | −12.9% | **−4.8%** |

**Every one of the ~27 cells is a §9R-E KILL. NET-PROFITABLE cells (ciLow > 0): NONE.**

**Best cell: buy NO 85¢ / HOLD to resolution = −4.8%, CI [−6.0%, −3.6%]** — still a decisive KILL. Ranked best:

| buy | sell | n | city-clustered mean | 95% CI | §9R-E |
|---|---|---|---|---|---|
| 85¢ | hold | 1081 | **−4.8%** | [−6.0%, −3.6%] | KILL |
| 75¢ | hold | 1077 | −5.4% | [−6.5%, −4.3%] | KILL |
| 65¢ | hold | 1075 | −6.4% | [−8.3%, −4.4%] | KILL |
| 85¢ | 95¢ | 1081 | −12.9% | [−14.5%, −11.2%] | KILL |

**Two monotonic patterns explain the whole surface:**

1. **HOLD always beats FLIP** — at every entry band, holding to resolution beats every flip target (e.g. buy 85¢:
   hold −4.8% vs the best flip −12.9%). The flip caps the winner's gain and dumps the losers, forfeiting the
   resolution value; this is the *exact* C7 flip-mechanics death, now confirmed universal on the NO side.
2. **Buying NO EXPENSIVE is least-bad; buying NO CHEAP is worst.** buy-85¢-hold −4.8% → buy-45¢-hold −14.1%.
   Buying NO at 85¢ (== YES 15¢, a longshot bucket) is a near-fair fee-only bet the bucket won't win — it wins
   ~85% but the margin is thin and the taker fee + residual adverse selection make it −4.8%. Buying NO cheap
   (45¢ == YES 55¢, a *favorite*) fades buckets that actually win ~half the time → deep loss.

**Bottom line: there is no net-profitable buy/sell combination anywhere on the NO surface.** The least-losing is
"sell insurance on near-certain no's and hold" (buy 85¢/hold, −4.8%) — which is just the taker fee + adverse
selection eating a fair bet. The market is efficient across the *entire* NO price × exit grid. (Same top-of-book
caveat: real depth only makes every cell worse. The MCP sizing query hit the Micro's 8s statement timeout — the
478k-row pull was done via the direct tsx connection, one plain join, no strain.)
