# Whale-Insider Scan — do $100k+ Polymarket bettors show an insider-information signature?

> Operator ask (2026-06-24): *"Run an extensive analysis of trades above $100k for the past 6 months.
> Identify users with a high amount of wins on big bets and the best net profit. The theory is that
> individuals with a certain behaviour act on insider information, and we want to isolate those users to
> the best of our ability."*

**Verdict — falsified, with the numbers.** Across **$1.22 B of ≥$100k bets over the last 6 months
(5,763 fills, 278 big-bettor wallets, 2,103 markets)**, there is **no detectable insider-information
signature** — neither as a repeated edge nor as one-off underdog hits. The big-money edge on Polymarket
is **sports / live in-game trading skill** (67% of all whale notional, ~100% of every profitable top
wallet). The one statistical outlier is fully explained by live sports betting. This is read-only
analytics; the live-trading rail stays DORMANT (`FINDINGS.md`).

Engine: `scripts/research/whale-insider-scan.ts` · outputs: `scripts/research/out/whale-insider-scan.{json,md}`
· re-run: `pnpm tsx scripts/research/whale-insider-scan.ts`.

---

## 1. What "insider information" actually looks like — and why naïve ranking fails

The operator's instinct (high win rate + big net profit ⇒ insider) is the right starting point but
under-specified, because two skill-based patterns produce exactly that fingerprint **without any private
information**:

1. **Buying near-certainty.** A $100k bet at 0.97 that wins is a 3% return, not information — the market
   already knew. High win rate, zero edge.
2. **Live in-game sports trading.** Betting the favorite *during* a match (price 0.85, resolves minutes
   later) wins ~85% of the time. That is skill at watching a game, and the "information" (the live score)
   is **public**.

A genuine insider edge is the opposite shape: a **large bet at non-obvious odds (≈0.2–0.7), placed with
lead time *before* resolution, on a *resolvable non-sports event* (a crypto move, an appointment, a
geopolitical outcome), that then wins far more often than the odds it paid implied** — and ideally
**repeatedly**. So the scan measures three things, not one:

| Lens | Question | Statistic |
|---|---|---|
| **A — Net profit** | Who made the most on big bets? | held-to-resolution P&L of the ≥$100k fills |
| **B — Win-rate edge** | Who wins more than the odds they paid implied? | `z = (wins − Σp) / √Σp(1−p)` over independent resolved markets |
| **C — Information profile** | …restricted to the *insider-shaped* subset | the same `z`, but only **non-sports, odds ≤ 0.90, placed > 1 day before resolution** |

The null for B/C is market efficiency: a bet entered at price `p` wins with probability `p`, so expected
wins over a wallet's resolved bets = `Σ p`. Winning materially more than that — a high `z` — is the only
thing that *can't* be explained by "they paid for what they got." Near-certain entries (≥0.98 / ≤0.02)
are dropped from `z` (pure microstructure, no information content). `z` is computed over **independent
markets**, not fills, so splitting one bet into ten fills can't manufacture significance.

---

## 2. Data & method (all keyless, read-only; live-verified API constraints)

**Discovery — who are the whales?** The global `/trades?filterType=CASH&filterAmount=100000` feed (recent
big fills) ∪ the `/v1/leaderboard?orderBy=PNL` profit leaderboards (ALL + MONTH, the biggest net-profit
wallets) ∪ known sharps. → **586 candidates.**

**Per-wallet big bets.** `/trades?user=W&filterType=CASH&filterAmount=100000` → each wallet's ≥$100k fills,
cut to the trailing 180 days. → **278 wallets** placed a ≥$100k bet in-window.

**Grading — did the bet win?** Each market's **authoritative winning outcome** from CLOB
`/markets/{conditionId}` → `tokens[].winner` (serves archived markets too). Each big fill is marked
**held-to-resolution**: a BUY of outcome *O* returns `shares × ((O won?1:0) − price)`; a SELL the inverse.
This grades each fill on its *own* direction — fixing the trap where a wallet's market-level realized P&L
credits a near-certain **SELL @0.999** (profit-taking on a winning long) as a "0.1%-odds insider win."
Lifetime realized P&L (`user-pnl`) is carried as a corroboration column.

**Constraints that bound the scan (verified live 2026-06-24):**
- The global `/trades` feed **hard-caps at offset 3000, times out past ~offset 600, and ignores
  `start`/`end`** — so it cannot crawl a clean 6 months; it only seeds *recently-active* whales. The
  leaderboard (offset-pageable) covers the persistent big winners. **Discovery is therefore
  recency + leaderboard bounded** — a whale active only mid-window with no leaderboard footprint can be
  missed. (The `whale_trades` table from the whale-watch alarm now accumulates ≥$100k trades forward, so
  re-running improves coverage over time.)
- The old Goldsky subgraphs (the exhaustive on-chain source) are **404 / deleted** — not available.

---

## 3. Results

### The money is in sports

Category mix of the **$1.16 B** of *resolved* big-bet notional:

| Category | Notional | Share |
|---|--:|--:|
| **Sports** (incl. esports, "Will X win on DATE", spreads, O/U) | **$777 M** | **67.1%** |
| Other (geopolitical / misc resolvable events) | $246 M | 21.2% |
| Politics | $93 M | 8.1% |
| Crypto | $42 M | 3.6% |
| Weather | $0.3 M | 0.0% |
| Macro (CPI/rates/GDP) | $0 | 0.0% |

Every wallet in the top-30 by net profit and by win-rate-edge is **~100% sports**.

### A — Best net profit on big bets (held-to-resolution)

| # | Wallet | Markets | W/L | Win% | Category | z | Net (held) | Lifetime |
|--:|---|--:|---|--:|---|--:|--:|--:|
| 1 | endlessFate | 7 | 5/2 | 71% | sports 100% | 1.3 | **$6.62 M** | $7.41 M |
| 2 | frostrizz | 4 | 4/0 | 100% | sports 100% | 1.5 | $5.82 M | $8.93 M |
| 3 | mintblade | 2 | 2/0 | 100% | sports 100% | 1.3 | $4.94 M | $9.24 M |
| 4 | `0x2a2c53…` | 284 | 195/66 | 75% | sports 96% | 1.3 | $4.03 M | $4.23 M |
| 5 | kch123 | 165 | 92/68 | 58% | sports 98% | 1.0 | $4.02 M | $11.36 M |

These are **skilled sports sharps**, corroborated by large positive *lifetime* P&L. Their `z` is mostly
< 2 — i.e. their profit comes from **size and volume at fair-ish odds**, not from winning more than the
market priced. Nothing anomalous.

### B — Win-rate edge (`z`)

Only **one** wallet clears `z ≥ 3` over its non-trivial bets: **Latina** (`0x264378…`), `z = 3.72`. But
read the evidence:

```
Latina — 64 resolved big bets · 20W/44L (31%) · category mix: 100% sports ($26.4 M)
  INFORMATIVE-subset zInfo = — (0 informative bets)
  Top wins:
    • Spread: Germany (-3.5)        MIXED @0.830  $2.09 M → +$654 k   (0.0 d lead)
    • Knicks vs. Spurs              BUY   @0.360  $0.22 M → +$389 k   (0.0 d lead)
    • Will United States win 06-12  MIXED @0.846  $0.96 M → +$269 k   (0.0 d lead)
    • Will France win on 06-16      MIXED @0.909  $1.70 M → +$228 k   (0.0 d lead)
```

Every winning bet is **sports, at favorite-ish odds, entered at 0.0 days to resolution** — the textbook
**live in-game trading** profile. The `+27 pp` "edge" is the live-betting edge over the pre-game-ish line,
not information. Skilled, interesting, **not insider.**

### C — Information profile (the insider-shaped lens) — **EMPTY**

Restricting `z` to the insider-shaped subset (non-sports, odds ≤ 0.90, placed > 1 day before resolution):

- **Only 20 of 278 wallets made even ONE such bet.** Most whales place **zero** non-sports, early,
  non-trivial-odds bets.
- The **highest `zInfo` is 1.25** (wallet `A1d29`, a single crypto bet, n = 1 — statistically
  meaningless). Roughly half of the 20 *lost* their informative bets.
- **The information watchlist (`zInfo ≥ 3`, ≥ 4 informative bets, P&L > 0) is empty.**

### One-off lens (the pattern `z` structurally can't see)

A true insider trade is often a *single* event, not a repeated edge — which a per-wallet `z`-test cannot
detect. So the entire dataset was swept for **individual** ≥$100k **non-sports underdog** longs
(entry ≤ 0.50) that won. Across $1.22 B, there are **exactly 2** — and both are benign:

| Trader | Market | @odds | Size | Profit | Lead | Why it's not insider |
|---|---|--:|--:|--:|--:|---|
| Countryside | "Will Arsenal win the Champions League" | 0.466 | $853 k | +$250 k | 0.4 d | Football final (mis-binned as "other"); a sports result, bet at the final |
| A1d29 | "Solana Up or Down on Jan 12?" | 0.470 | $211 k | +$238 k | 0.0 d | A same-day ~50/50 crypto coin-flip that paid once |

---

## 4. Conclusion

**There is no isolable population of insider-information traders at the $100k+ tier on Polymarket over the
last 6 months.** The high-win-rate, high-net-profit whales the operator's theory predicted **do exist** —
but they are **sports sharps and live in-game traders**, whose edge is skill on public information (the
live game state, favorite-backing), corroborated by lifetime P&L. The insider-shaped signature (large,
early, non-sports, underdog, repeatedly winning) is **absent**: empty watchlist, only 20/278 wallets
making any such bet, none with a significant or repeated winning pattern, and only two benign one-off
underdog hits in the whole dataset.

If you want a wallet to *watch* anyway, the honest shortlist is the statistical outlier **Latina**
(`0x264378…`, `z = 3.72`) — labelled for what it is: an exceptional **live sports** trader, not an
insider.

---

## 5. Honest limitations (what this scan does *not* prove)

1. **"No systematic insiders" ≠ "no insider trade ever happened."** The `z`-test finds *repeated* edge; a
   one-shot insider who bet once and vanished accumulates no significance (n = 1). The one-off sweep
   mitigates this but is only as good as discovery.
2. **Discovery is recency + leaderboard bounded** (the global feed's offset-3000 cap + no time filter, and
   the dead subgraph). A mid-window one-off whale with no leaderboard footprint can be missed. Best
   structural fix: let `whale_trades` accumulate forward and re-run, or obtain an exhaustive on-chain
   source (current Polymarket subgraph / a Polygon log indexer).
3. **The category tagger is coarse** (regex over title/slug). Some sports markets leak into "other" (e.g.
   the Arsenal/Champions-League bet above) — which only makes the genuinely-insider-relevant non-sports
   pool *smaller*, reinforcing the verdict.
4. **Held-to-resolution P&L assumes the position is held to settlement.** For wallets that scalp in and
   out it can misstate realized money (hence the lifetime-P&L corroboration column); for the *directional*
   insider question ("did their big bet's side win") it is exactly the right measure.
5. **Threshold sensitivity.** At $100k the non-sports resolvable-event population is genuinely thin.
   Lowering to ~$25–50k would surface far more crypto / politics / geopolitical markets where insider
   information is more plausible — a reasonable next pass if the operator wants to widen the net:
   `pnpm tsx scripts/research/whale-insider-scan.ts --threshold 25000`.

---

## 6. Re-run / extend

```bash
# full 6-month scan (default $100k / 180d)
pnpm tsx scripts/research/whale-insider-scan.ts

# widen the net to surface more non-sports resolvable markets
pnpm tsx scripts/research/whale-insider-scan.ts --threshold 25000 --days 180

# tune the flags (min independent bets / z bar for the watchlists)
pnpm tsx scripts/research/whale-insider-scan.ts --min-resolved 4 --z-flag 3
```

Outputs: a ranked console report + `scripts/research/out/whale-insider-scan.json` (full per-wallet
records, both watchlists, every graded big bet) + `…/whale-insider-scan.md` (the report).

---

## 7. The $25k widened pass — the verdict gets *stronger* (`…-25k.json`)

Re-ran at **`--threshold 25000`** to reach the non-sports markets the $100k floor mostly filters out.
**4× the data: 43,323 fills · $3.0 B notional · 9,858 markets · 531 big-bettor wallets.** The result is not
just confirmed — it is sharpened into the cleanest possible disproof:

- **The information watchlist (`zInfo ≥ 3`) is *still empty*.** With 4× the data and far more non-sports
  markets, not one wallet shows an anomalous winning pattern on early, non-sports, non-trivial bets.
- **The statistical-anomaly watchlist (all-odds `z ≥ 3`) now has 6 — every one ~100% sports, every top
  win at 0.0-day lead.** VPenguin (z=4.3, 73W/176L), superbeter007 (z=3.9), Tirdenchi (z=3.7),
  wupplasaurus (z=3.4), `0x594d0c…` (z=3.2), Latina (z=3.1) — all soccer / esports / NBA, **live in-game**.
  High `z`, zero information. This is the scan working correctly: it finds live-trading skill and labels it.
- **The decisive evidence — the natural insider habitat is empty.** In H1 2026 the heavily-traded
  non-sports cluster was **Iran / Middle-East geopolitics** ("US strikes Iran", "Khamenei out", "regime
  falls", ceasefire deadlines). These are *exactly* the resolvable, leak-able events where insider
  information would surface. The wallets that bet them most:

  | Wallet | Informative bets | `zInfo` | Info P&L | Read |
  |---|--:|--:|--:|---|
  | **denizz** | **23** (all geopolitics) | **0.08** | **−$188 k** | bets $3M+ on Iran outcomes, wins *exactly* as priced, loses money — **no edge** |
  | ScottyNooo | 14 | 0.32 | +$158 k | no edge |
  | MisTKy | 14 | 1.22 | +$114 k | no edge |
  | BowlOfPunch | 5 | 2.43 | +$281 k | the lone mild outlier — but it's **longshot-fading** (SELL "Platner nominee"@0.34, SELL "Khamenei out"@0.83, all resolved NO) = the well-known overpriced-tail edge, **not information**; sub-significant at n=5 |

  A wallet (denizz) putting eight figures through the precise markets where insider info would pay shows a
  `zInfo` of **0.08** — the market is efficient w.r.t. these events. If insiders were trading them at size,
  this is where it would show. It doesn't.

**Bottom line across both passes:** the only non-sports edge that even flickers is **systematic
longshot-fading** (BowlOfPunch), and it's sub-significant. There is no insider-information signature at
$25k or $100k. If you want one wallet to eyeball, BowlOfPunch is it — labelled honestly as a skilled
political-tail fader, not an insider.
