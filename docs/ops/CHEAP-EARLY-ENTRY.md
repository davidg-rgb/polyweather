# CHEAP-EARLY-ENTRY — the operator's "buy earlier, cap at 3×, occasional buy" proposal (2026-07-25)

> **VERDICT: UNPROVEN, not dead — and the first cheap-buy variant that isn't obviously killed.** The
> operator's two instincts both check out on the data: (1) **buying earlier fixes the "lost causes" problem**
> — capping the price in the final [2,12]h buys buckets the field has already abandoned (win ~1%), while the
> **12–36h band** buys them before the running-max floor collapses the field (win ~25–42% in-sample); and
> (2) **cost is not the wall** — the real half-spread is 0.3–1c and the house-pick executable depth is
> **$130–310 median** in that band (86–99% of picks clear $5, ~80% clear $25). But the **edge itself does not
> clear**: on the ~1 month of real book we have (76 live events / 19 days), the best cells sit near zero with
> CIs spanning roughly **[−70%, +120%]**, and the larger mid-price sample (184 events) puts the calibration
> gap at **+1.2pp — inside the round-trip cost**. It is a **forward-paper question, not a capital decision**:
> no refutation, no proof. Read-only; nothing traded.

Operator proposal (2026-07-25): move the buy window off the final hours to the first day, cap at a max price
that pays ≥3× (sub ~33c), accept a **low fire rate** ("occasional buy, we have time"). Thesis: breakeven
win-rate = 1/3 = 33.3%; if our prediction wins > that, the 3× is net positive.

Engines: `scripts/research/bid-path-discovery.py` (mid panel) + `scripts/research/cheap-entry-realbook.py`
(real book). Artifacts in `scripts/research/out/`.

---

## 1 · Two data surfaces (and why both)

- **Mid-price panel** (`market-history-flat-enriched.parquet`): 184 live-city events **with a forecast**,
  Jan–Jun 2026 — the larger sample for the **win-rate/gap structure**, but mid only (assumed spread).
- **Real order book** (`opening-captures-archive`): **76 live-city events / 19 days, Jul 5–23** — the actual
  `bestAsk`/`bestBid`/`depth` per bucket over each market's full ~56h life. The decisive **cost + real-fill**
  read, but small. (This is the "months of bid data" — in practice ~1 month, growing ~4 live events/day as
  the capture keeps running.)

Grading is by **winner temperature** (parsed from the label), never bucket index — the sort-safe join
(traps #7). House pick = `argmax(houseProb)` from the live seed, i.e. exactly what the bot would buy.

## 2 · The timing sweep — the operator's core insight, quantified

Buy our house pick capped ≤0.33, hold to resolution, **lead-appropriate forecast (no look-ahead)**:

| Entry window | mid win% | mid gap (win−price) | **real-book net** (bestAsk, hold) | real-book n |
|---|---|---|---|---|
| [2, 12]h (current lane) | 0.9% | +0.4pp | **−104%** (total loss) | 22 |
| [12, 18]h | 7.9% | +0.2pp | −8% to −25% | 10–12 |
| [18, 24]h | 12.8% | −2.3pp | −17% to −45% | 8–17 |
| [24, 36]h | 14.8% | −3.9pp | −7% (all) / **+34%** (0.20–0.33 band) | 12–17 |
| [36, 54]h (open) | 20.8% | +1.2pp | −104% (n=14, all lost) | 14 |

The final-hours cap is a guaranteed loser (buys dead buckets); moving earlier lifts it out of the hole. But
note the mid panel (Jan–Jun) likes the **very open** [36,54] while the real book (Jul) likes **[24,36]** and
shows [36,54] losing — the two samples **disagree on where the best cell is**, which is the fingerprint of
noise, not a stable edge. The one positive real-book cell (**[24,36]h, 0.20–0.33: win 42%, ask 28c,
net +34%**) is **n=12, CI [−50%, +122%]** — the "if we hit the right markets" cell, real but unpowered.

## 3 · Item (c) — the real cost, measured (spread is tight, depth is fine in the band)

Real book, cheap buckets, by hours-to-close:

| Window | real half-spread | **house-pick depth (median)** | % of picks ≥ $5 | ≥ $25 |
|---|---|---|---|---|
| (0, 12]h | 0.5c | $1 (dead longshots) | 31% | 15% |
| **(12, 18]h** | 0.4c | **$313** | 86% | 77% |
| **(18, 24]h** | 0.5c | **$193** | 95% | 76% |
| **(24, 36]h** | 0.3c | **$138** | 99% | 82% |
| (36, 60]h | 1.0c | $18 | 77% | 40% |

**Neither cost is the wall in the 12–36h band.** The half-spread is ~0.3–1c (I had assumed 2.3c — pessimistic),
and the pick's executable depth is $130–310 median — ample for a $5–25 stake. (An earlier read of "$1–2 depth"
was measuring *all* cheap buckets, which is dragged to ~$1 by dead sub-cent longshots the strategy never
buys — corrected here.) The open [36,60]h is where depth thins ($18) — another reason to prefer **12–36h**
over the very first hours of listing.

## 4 · Why it doesn't clear (yet), and why "occasional buy" cuts both ways

- **The gap is inside the noise.** The mid panel's +1.2pp calibration gap is smaller than the (tiny) round-trip
  cost, and the real-book cells straddle zero by ±100%. The 3× arithmetic needs win-rate **materially above**
  the price; capping ≤33c still selects the cases where the market disagrees with us, and the market is
  well-calibrated — our bucket wins ≈ its price even 1–2 days out (the favorite-longshot gap is real but small).
- **Selectivity makes proving it slower, not the edge bigger.** "Occasional buy" is fine for *deployment* but
  fatal for *inference*: the best cell fires ~0.6 entries/day → **~60 live days just to reach the n≥40 gate
  floor**, and the heavy-tailed 3× payoffs (a 25c winner pays 4×) need more than that to shrink the CI below
  its own width. Time on our side helps execution; it does not shortcut the §9R-E gate.

## 5 · Verdict + the honest path forward

- **Not KILL, not GO — INSUFFICIENT.** Uniquely among the cheap-buy family, this survives its cheap gates
  (timing works, spread + depth are real and adequate in 12–36h). It has **not** been shown +EV, and the
  larger sample argues it's ~breakeven-negative. It earns a **forward paper test**, never capital
  (the project's standing discipline: a backtest — especially a 76-event one — never earns money).
- **The test that would settle it:** a forward paper panel at the **[24,36]h window, 0.20–0.33 ask band**
  (the liquid, best-looking cell), house-pick, hold-to-resolution, graded by the §9R-E gate — run until
  n≥40 / ≥6 cities / ≥7 days (~2 months at 4 cities). The opening-capture stream already collects the book;
  this is a scoring layer, not new capture. **BUILT + tested 2026-07-25** (operator-directed): engine
  `core/sim/cheap-early-entry-replay.ts` + view + migration `0117` + edge fn `cheap-early-panel` (hourly) + the
  `/cheap-early` dashboard; the forward engine reproduces this doc's §2 [24,36]/0.20–0.33 cell byte-for-byte
  (`scripts/research/cheap-early-forward-regression.ts`: n=12 / win 42% / net +33.9%). **Deploy is operator-gated**
  (apply 0117 + deploy the edge fn — `CHEAP-EARLY-ENTRY-FORWARD-HANDOFF.md` §Deploy); no capital before a frozen PASS.
- **What would change the verdict fast:** widening to more cities raises the fire rate and powers it sooner
  (the mechanism, if real, isn't city-specific). Modelling (the operator's note) could help *selection*
  within the band, but can't manufacture an edge the market hasn't left — the ceiling is the +1.2pp gap.

## 6 · Reproduce

```bash
python scripts/research/cheap-entry-realbook.py           # real-book spread/depth + band×window sweep
python scripts/research/bid-path-discovery.py extract     # (if not built) the mid feature panel
# mid-panel band×window numbers: the lead-appropriate sweep in this doc's §2
```
Artifacts: `scripts/research/out/cheap-entry-realbook.json`, `live-winners.json`, `bid-path-features.parquet`.
Boundary held: read-only, no trade, no credentials; writes confined to `scripts/research/out/` + this doc.
