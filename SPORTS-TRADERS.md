# Sports Traders — who are the best, and can we mirror them?

**Question (operator, 2026-06-25):** find the most successful *sports* traders on Polymarket, and —
follow-up — can we build something to mimic their bets?

**TL;DR.** Part 1 is done: the SPORTS leaderboard is directly queryable; the roster is §1 (swisstony, kch123,
RN1, mintblade, fishalive, frostrizz, … $9–12M lifetime, ~100% soccer / major-sport). Part 2 — copy-trading
them — was **measured, not guessed, and it FAILS**. Two trader archetypes, two distinct failure modes:

- **Volume machines** (swisstony, RN1, kch123 — ROI ~1–4% on $0.3–1.1B turnover): at a credible sample their
  per-dollar edge **regresses to ≈ 0** (own EV +2.5% / −1.4% / −4.7% over 150–200 resolved bets). There is
  almost no surplus per dollar to copy, and a follower nets **negative at every detection lag and spread**.
- **High-ROI specialists** (mintblade, fishalive, frostrizz — ROI 40–70%): show a **~100% win rate** on their
  resolved big bets (100/100, 41/41, 106/108) at 0.35–0.60 entry odds. The naive mirror "PASSES" — but that
  pass is **not real**: it is (a) survivorship from conditioning on resolved winners, and (b) — decisively —
  these are **book-sweepers**, so the post-fill "mark" price is **not an executable ask** for a follower; the
  sharp has already eaten the cheap liquidity. You cannot transact where the backtest pretends you can.

So: the credibly-graded edge isn't copyable, and the copyable-looking edge isn't credibly tradeable. This is
the same "late-follower / market-efficient-to-a-mirror" result the weather copy-trade hit (−6%/$1,
WALLET-RECON-HANDOFF §11), reached via the same reused engine. **The live rail stays DORMANT** (FINDINGS.md).

> Data: `scripts/research/sports-traders-scan.ts`, large-sample run (200 fills/wallet, top 6), authoritative
> resolution from CLOB `/markets/{conditionId}`. Engine `core/sim/sports-copytrade.ts` (+25 unit tests),
> reusing the tested `sim/copy-trade.ts` mirror. Outputs in `scripts/research/out/sports-traders-scan*.{md,json}`.

---

## 1. Part 1 — the roster (the answer to "find the best sports traders")

Polymarket's data-api leaderboard takes a `category=SPORTS` filter directly — no key, no scraping:
`GET https://data-api.polymarket.com/v1/leaderboard?category=SPORTS&timePeriod={DAY|WEEK|MONTH|ALL}&orderBy={PNL|VOLUME}`.
Ranked by **all-time P&L** (ROI proxy = P&L / volume):

| # | Trader | P&L (all-time) | Volume (all-time) | ROI proxy | Archetype |
|--:|--------|---------------:|------------------:|----------:|-----------|
| 1 | **swisstony** | $11.9M | $1.15B | 1.0% | volume machine |
| 2 | **kch123** | $11.5M | $293M | 3.9% | volume machine |
| 3 | **RN1** | $9.4M | $666M | 1.4% | volume machine |
| 4 | **mintblade** | $9.2M | $17.8M | **52.0%** | high-ROI specialist (in-play soccer) |
| 5 | **fishalive** | $9.1M | $13.3M | **68.2%** | high-ROI specialist |
| 6 | **frostrizz** | $8.9M | $23.1M | **38.7%** | high-ROI specialist |
| 7 | GRIMDRIP | $7.6M | $13.6M | 55.9% | high-ROI specialist |
| 8 | endlessFate | $7.4M | $26.3M | 28.2% | high-ROI specialist |
| 9 | KeyTransporter | $5.7M | $20.1M | 28.4% | high-ROI specialist |
| 10 | gmanas | $4.7M | $488M | 1.0% | volume machine |

The split is the whole story:

- **Volume machines** (ROI ~1%): a razor-thin per-dollar edge run over hundreds of millions to billions in
  turnover. The dollars come from *size*, not from a fat edge — and at sample, the edge is ≈ 0 (§3).
- **High-ROI specialists** (ROI 30–70%): smaller turnover, a huge per-dollar number. These are the in-play
  soccer sharps. mintblade's whole sampled book is soccer, 100% of fills in the 0.40–0.60 band, **98.6% of
  fills part of a same-second book-sweep**, median $50–90k fills — the signature of a **fast in-game bot**
  sweeping offers as a match breaks.

Consistent with the prior whale-insider scan (WHALE-INSIDER-SCAN.md): the top whales are sports specialists
and the edge is **live-trading skill, not material non-public information**. The roster above is the named list.

---

## 2. Part 2 — can we mirror them? The method

The copyability question is **not** "do they win" (they do). It is: *by the time a follower can act on a
public fill, is the residual edge — net of the taker fee and the spread — still positive?* A copy-trader is by
construction a **late follower**: they see the fill only after it prints, then must **cross to the ask** to
guarantee a fill (you cannot out-rest a maker already there). We measure exactly that.

**Reused machinery (no new EV math).** The probe feeds the tested `sim/copy-trade.ts::simulateMirror` — same
engine, fee model (`takerFeeTotal`), and bootstrap-CI verdict (`copyTradeVerdict`) as the weather study. The
only sports-specific code is `sim/sports-copytrade.ts` (CLOB-history → book snapshots, the trader fingerprint,
the fill-aligned drift curve), unit-tested. **Pre-registered** kill-criterion (do **not** move it to fit the
result — WO-5 discipline):

> **PASS** iff the follower's fee-net EV/$1 **95% bootstrap-CI lower bound clears 0**. CI straddles/below 0 →
> "late follower" confirmed.

**Data per trader.** Large fills (`/trades?user=…&filterType=CASH&filterAmount=10000`); per fill, the bought
token's CLOB `/prices-history` at 1-min fidelity around the fill (the **price path** — follower entry + drift);
and **authoritative resolution** from CLOB `/markets/{conditionId}` (`closed` + per-token `winner` — *not* a
price-tail heuristic, which would mislabel still-open markets). Swept across **detection lag** {60, 300, 900 s}
× **spread haircut** {0, 1, 2 %}. The 0% haircut is the *optimistic* follower (pays the mark, not the ask) — a
kill test: if even that follower can't capture it, copying is dead for any real spread.

---

## 3. The volume machines — no surplus to copy (clean FAIL)

At a credible sample the thin edge regresses to noise around zero:

| Trader | n (resolved BUYs) | win % | implied % | edge | **own EV/$1** |
|--------|--:|--:|--:|--:|--:|
| swisstony | 163 | 74.2 | 70.1 | +4.1pp | **+2.5%** |
| RN1 | 189 | 73.5 | 74.1 | −0.6pp | **−1.4%** |
| kch123 | 200 | 60.0 | 62.0 | −2.0pp | **−4.7%** |

With ≈ 0 edge per dollar, there is nothing to mirror. swisstony — the single best case (own EV +2.5%) — the
**follower nets negative at every cell**, captured fraction deeply negative:

| haircut \ lag | 60s | 300s | 900s |
|---|---|---|---|
| 0% | −0.6% [−11.4, +10.2] ❌ | −0.8% ❌ | −6.0% ❌ |
| 1% | −2.0% ❌ | −2.2% ❌ | −7.2% ❌ |
| 2% | −3.4% ❌ | −3.6% ❌ | −8.4% ❌ |

The follower pays the spread + fee for an edge that wasn't there. RN1 and kch123 are worse (their own EV is
already ≤ 0). **FAIL, unambiguously.** These wallets make $10M on $1B of turnover via a sub-1%-per-dollar edge
(very plausibly the maker rebate + size, not a forecast); that is not a thing a taker-follower can rent.

---

## 4. The high-ROI specialists — the "100% win" trap (a PASS you must not believe)

mintblade / fishalive / frostrizz post **~100% win rates** on their resolved big BUYs — and it **persists** at
larger n, so it is not a small-sample fluke:

| Trader | n (resolved BUYs) | win % [95%] | implied % | **own EV/$1** | drift @+300s / +1800s |
|--------|--:|--:|--:|--:|--:|
| mintblade | 100 | 100.0 [96.3, 100] | 45.7 | +126.6% | +0.5pp / +12.6pp |
| frostrizz | 108 | 98.1 [93.5, 99.5] | 60.0 | +67.2% | +1.4pp / +11.7pp |
| fishalive | 41 | 100.0 [91.4, 100] | 35.3 | +355.4% | +0.2pp / +7.0pp |

The naive mirror grid **PASSES every cell** for mintblade (follower +99% to +126% EV, captured ~80–99%). **It
is not a tradeable signal.** Two independent biases, both fatal:

1. **Survivorship / conditioning.** The probe scores his **resolved** big BUYs. If big size clusters on
   eventual winners (he adds as a live match breaks his way) and losing exposure sits in **still-open** markets
   or is exited before settling, the resolved subset is mechanically winner-heavy. A real copier — copying
   *all* his bets live, blind to the future — does not get 100%. The high `capturableFraction` is then
   tautological: "if you only copy his winners, you win."

2. **The mark price is not an executable ask — and he eats the liquidity.** The drift curve is the tell: the
   price is **flat for the first ~5 minutes** after his fill (+0.1 to +0.5pp), then climbs only later. The
   mirror reads that flat "mark" and pretends a follower could buy there at +60–300s. But mintblade **sweeps
   the book** (98.6% same-second bursts, $50–90k median): he is *taking every cheap offer*. After the sweep the
   last-trade mark may still print ~0.50, but there is little or no size left to actually buy at 0.50 — the
   `/prices-history` mark ≠ the ask a follower would face. For a sweeping sharp the modeled follower entry is
   **fiction**; he has consumed the very edge a copier would need.

Net: the specialists' edge is most consistent with **live-latency arbitrage on a momentarily-stale book** —
the *least* copyable edge there is. You'd have to be as fast as the bot and find liquidity it hasn't already
taken; by the time the fill is public, the opportunity (and the cheap size) is gone. "100% win, PASS
everywhere" is the **"too-good-to-be-standing"** smell the project already distrusts (REC-8): it fails the
credibility gate before the statistics gate.

---

## 5. Why this was the expected result (and is robust)

Three independent, consistent reasons:

1. **Structural.** A live-trading edge is a *latency* edge; a follower is *defined* by being late. Copying a
   latency edge is the textbook un-copyable case — strictly harder than the weather **maker** edge, which
   already failed at −6%/$1.
2. **Measured.** Volume machines: edge ≈ 0, follower negative at every lag×spread (two haircut bounds, three
   lags, all FAIL). Specialists: the only "PASS" rests on a 100% win rate + a non-executable mark — fiction.
3. **Prior.** Same engine, same pre-registered criterion, same "market efficient to a mirror" conclusion as
   the weather sharp (badatmath, §11). This extends the project's falsified-replication ledger (FINDINGS.md)
   from weather to sports.

---

## 6. What we built (the durable deliverable)

The (negative) trade verdict notwithstanding, the tooling is the analytics product:

- **`packages/core/src/sim/sports-copytrade.ts`** (pure, 25 unit tests) — market categoriser (+ sub-sport),
  CLOB-history → book-snapshot construction (with the spread-haircut optimism dial), authoritative-resolution
  passthrough, the **trader fingerprint** (entry-odds histogram, sweep/burst detector, sub-sport mix, win-rate
  vs implied with a Wilson interval), the **fill-aligned drift curve**, and `sharpOwnEdge`. Reuses
  `simulateMirror`/`copyTradeVerdict`/`armEdgeStats`/`takerFeeTotal` rather than reimplementing them.
- **`scripts/research/sports-traders-scan.ts`** — the impure spine: SPORTS-leaderboard roster, per-wallet
  fingerprints, and the copyability probe (lag × haircut grid + drift curve), cached, emitting `.md` + `.json`.

This is a reusable **"who are the sharp sports traders and how do they bet"** instrument — a `/sharps`-style
leaderboard + style fingerprints. That insight is the shippable value, even though the bets aren't copyable.

---

## 7. Recommendation + open thread

- **Do not build a live sports copy-bot.** The credibly-graded edge is not capturable by a follower, and the
  copyable-looking edge is non-executable (sweeper consumes the liquidity). Building execution would invest in
  a falsified lever against the project posture. The rail stays **DORMANT**.
- **Ship the analytics, not the trade.** If anything reaches the dashboard, it's the sports-sharps roster +
  fingerprints (a `/sharps` page), consistent with the "the product is the insight" pivot (FINDINGS.md).
- **Genuinely-distinct open thread (research, not capital):** the specialists' edge is the *first* clearly
  live-latency-arb signature the project has isolated. The only thing that could ever touch it is **being the
  fast actor, not the follower** — a real-time in-play book-staleness detector that fires on the same event the
  bot does, on markets it hasn't already swept. That is a latency-arb build (own infra, own speed), **not** a
  copy of anyone, with a low prior and a high engineering bar. Note it; don't fund it without a separate spike.
- **Re-open trigger:** only a copy-trade probe that **PASSES the pre-registered criterion on a
  credibly-graded sharp** (CI lower bound > 0, on real win rates and executable prices — not a survivorship
  100% on a non-executable mark) would justify reconsidering execution. None does.

---

## 8. The `/sharps` dashboard — shipped (2026-06-25)

The durable deliverable from §6 is now a **live operator page**, built to the established `/rewards` +
`/whaletracker` idiom (`DASHBOARDS-HANDOFF.md`): cron-refreshed Supabase table → security-definer read RPC →
Next.js server page. **Pure analytics; the copy-trade rail stays DORMANT** — the page surfaces *who the sharp
sports traders are and how they bet*, with the §3–§4 verdict ("not copyable") stated on the page itself.

| Piece | Path |
|---|---|
| Migration — `sports_sharps` snapshot table + `record_sports_sharps` (service-role insert) + `dash_sharps` (operator read, jsonb-OBJECT, `operator_guard`, 0044/0054-safe) + daily `sharps-snapshot` cron at 02:00 UTC | `supabase/migrations/0059_sharps_dashboard.sql` |
| Edge ingest — daily tick: pull the SPORTS leaderboard across PNL/VOLUME × {DAY,WEEK,MONTH,ALL}, dedupe wallets, compute the **lightweight** fingerprint (entry-odds histogram, sweep/burst %, sub-sport mix, win-rate vs implied, own-EV) for the top wallets, bulk-upsert. Bounds the per-wallet fill crawl and **skips** the heavy per-fill `/prices-history` drift curve (that stays a research-scan artifact) to fit the edge wall-time budget. | `supabase/functions/sharps-snapshot/{index.ts,handler.ts}` |
| Page — roster table (rank, trader→profile link, P&L, volume, ROI proxy, archetype chip) + headline tiles + per-trader fingerprint cards (BarChart histogram, sweep %, sub-sport mix, win-rate vs implied, own-EV) + the §3–§4 "not copyable" verdict banner | `apps/web/src/app/(dash)/sharps/page.tsx` |
| Loader + nav | `apps/web/src/lib/loaders.ts` (`getSharps`) · `apps/web/src/app/(dash)/layout.tsx` (`/sharps` nav) |

The engine math is the already-tested `core/sim/sports-copytrade.ts` (`traderFingerprint`, `sharpOwnEdge`,
the reused `sim/copy-trade.ts` mirror) — the Edge tick only adds the bounded HTTP composition. Data accrues
from the first cron fire; until then the page shows an empty state.

## 9. Edge-hunt sweep close-out 2026-06-26 — fingerprint corrected; latency gate failed (C1 / C2)

The "turn every stone" sweep re-interrogated the sports edge at executable depth (lanes C1 + C2). Both KILL;
the live edge is real but unreachable from where we sit — and the prior "same-second sweep" figure was an
artifact.

**C1 — the specialist fingerprint is pre-kickoff ACCUMULATION, not same-second sweeping.** Re-measured at a
0s same-market window: true same-exact-second multi-leg share is **2.0% / 14.6% / 13.1%** (mintblade /
fishalive / frostrizz), **not 98.6%** — the prior figure (§1/§4) was a **120s-window artifact** (repeat adds
to the SAME 3 positions; mintblade 99.0% @120s vs 2.0% @0s). The real pattern: 96–100% pre-kickoff
accumulation at VWAP ~0.49, fills over 4–63min windows, 100% FIFA Club World Cup soccer. The only
out-performance (win 100%/100%/98.1% vs implied 45.7%/35.3%/60.0%) is **pure survivorship** on a
resolved-winners subset — no executable non-latency angle, **0 contracts of standing edge**. This re-confirms
§3–§4 "not copyable" from the mechanism up. Artifact: `scripts/research/lane-c1-fingerprint.ts`
(+ `out/lane-c1-fingerprint.{md,json}`); read-only, used the cached big-fill subset (zero new network).
**Caveat for any re-run:** widen beyond the single-tournament cache (lower the cash floor, page deeper
`/trades`) before treating "2% same-second" as the steady state.

**C2 — the §7 latency-arb is out of reach by 300–1800×.** The staleness window closes **<1s** (same-second
sweep) vs our reachable reaction latency **300s** (best 5-min poll) to **1800s** (current 30-min cron) — the
gap is the OPPOSITE sign of the PASS requirement (window must be WIDER than latency), zero overlap. Residual
at +300s = +0.1–0.5pp and non-executable (the sweeper consumed the liquidity, mark ≠ ask); the 60s public
price-fidelity floor cannot even measure a sub-300s window. Binding executable at our reachable horizon ≈ 0
contracts. The §7 "latency-arb build (own infra, own speed)" remains the ONLY conceivable path and stays
explicitly out of scope — do not fund without a dedicated sub-second-infra spike (high engineering bar, low
prior). No copy-trade probe passes the pre-registered re-open criterion; the rail stays DORMANT. (No new
script — the load-bearing drift-curve number, flat first ~5 min + sweeper-consumed mark, is already in
`scripts/research/sports-traders-scan.ts`; C2 is gap arithmetic against it.)

## 10. fishalive RE-TEST 2026-06-29 — the $9M is REAL cash, but it is ONE bet on ONE game (n=1 KILL)

**Operator challenge (2026-06-28):** fishalive is a NEW account this month, ~$9M profit at ~69% margin, with the
activity page showing heavy repetition on the same ~47¢ bucket. *"$9M on a new account ≠ survivorship — re-test it."*
He was **right to force the re-test**: the prior §4/§9 dismissal ("survivorship + a non-executable in-play book-sweep
mark") was **mechanically wrong** for fishalive. The corrected mechanism lands on an even more decisive KILL.

**Step 1 — realized-PnL reconciliation (the cash-flow identity, `scripts/wallet-forensics.ts`).** The displayed $9M is
**real, withdrawable cash, not a mark-to-market artifact**:

| | |
|---|---:|
| Σ BUY cost | **$4,284,848** |
| Σ SELL proceeds | **$0** (he never sells) |
| Σ REDEEM proceeds | **$13,281,460** (winning shares paid at $1) |
| Reconstructed realized | **$8,996,612** |
| Polymarket user-pnl curve (ground truth) | $9,063,378 |
| **Reconciliation** | **0.74% abs** ✓ |

Crawl complete (mode=full, not capped, `incomplete:false`); the user-pnl curve confirms the account's **first fill is
2026-06-15**, so this reconciles a true lifetime. Survivorship-of-a-win-*rate* is therefore the wrong frame — you cannot
mint $13.28M of actual redemptions by conditioning on resolved winners. **The cash is real.**

**Step 2 — soccer-aware forensics (`scripts/research/fishalive-forensics.ts`, authoritative CLOB resolution).** The
entire wallet is **ONE day, ONE game, TWO correlated legs** — `fifwc-esp-cvi-2026-06-15` = **Spain vs Cape Verde, FIFA
World Cup, kickoff 16:00 UTC**:

| Market (CLOB question) | His leg | VWAP | Cost | Redeem | Realized | Resolved |
|---|---|--:|--:|--:|--:|:--|
| *Will Spain win on 2026-06-15?* | **No** | **0.092** | $437k | $4,738,875 | **+$4.30M** | No ✓ (Spain did not win) |
| *Spread: Spain (−2.5)* | **Cabo Verde** | **0.451** | $3,847,446 | $8,539,052 | **+$4.69M** | Cabo Verde ✓ (Spain did not win by 3+) |

Both legs are the **same directional thesis — *Spain fails to beat Cape Verde*** — staked **$4.28M PRE-MATCH**. The
operator's "~47¢ bucket repeated on the same game" is exactly the 45¢ spread leg: ~802 fills accumulating 8.54M shares of
one outcome (median fill **$9**, max $427k). The cheap 9¢ "No" leg is the high-conviction longshot (the *outright*
favorite fade); the 45¢ spread is the bulk near-even-money expression of the same view. Spain (a top side) was priced a
~91% favorite (No at ~9¢) — and **the upset hit**.

**Microstructure (all confirm the corrected mechanism):**
- **100% PRE-KICKOFF** — median first-fill latency **−3,417s (~57 min before kickoff)**, 0% in-play. → The §7/§9
  "in-play latency arb" mechanism is **FALSIFIED for fishalive**: he is a pre-match conviction buyer, not an in-game
  sweeper.
- **59.6%** of fills share their exact second+market — he **swept the book** pre-match, paying *up* (the "No" leg walks
  from <10¢ into the 10–25¢ band as he accumulates): urgent aggressive accumulation, not patient resting.
- **0 markets held both Yes+No**, 0 sells, all real redemptions → **clean directional; NOT wash / self-cross / farming.**

**Ranked mechanism hypotheses (evidence-weighted):**
1. **Informed pre-match edge (team news / motivation) — most consistent with the structure, unprovable at n=1.** A $4.3M
   pre-match stake on a 9–45¢ favorite-fade in a real World Cup fixture is the signature of someone acting on a specific
   read — most mundanely, **Spain resting its first XI** (a final group game where Spain had already advanced is the
   textbook "favorite won't try" setup), or a lineup/injury leak. Reachable only with a soccer team-news pipeline we
   don't have; and n=1 cannot separate "informed" from "lucky."
2. **Structural favorite over-pricing (anti-favorite-longshot).** Extreme mismatch favorites may be systematically
   overpriced (public money on the big name); fading them could be +EV. This is the **only testable** hypothesis — but it
   needs *many* fixtures, not this one, and is a soccer-modeling project orthogonal to weather (low prior, no infra).
3. **Contrarian whale who got paid — the null we cannot reject.** At n=1, "$9M of skill" is statistically
   indistinguishable from "a rich contrarian put $4.28M on an upset and it landed." The leaderboard rank is a *single
   binary resolution*, not a track record.
4. **Wash / volume / reward farming — REJECTED** by the data (clean directional, no both-sides, no sells).
5. **In-play latency / information repricing — REJECTED** (100% pre-kickoff).
6. **PnL/leaderboard artifact — REJECTED for the cash (0.74% reconcile); CONFIRMED for the "elite trader" framing** (one
   correlated bet, not a repeatable edge).

**Reachability verdict — KILL-confirmed, corrected reason.** The prior KILL's *mechanism* was wrong (pre-match, not
in-play), but the lever is *more* dead than before: **the entire track record is a single pre-match event (n=1).** There
is no samplable, repeatable, copyable edge — you cannot build a system on one coin landing heads, and if it was
information it is event-specific and not piped to us (Sweden, keyless). **"What does he know?"** — on *this* game he had
extreme conviction (very plausibly an information or lineup read) that Spain would fail to win, and he was right; the data
cannot prove it was skill rather than luck, and either way it does not generalize. The 9th-signal rail stays **DORMANT**.
Artifacts: `scripts/research/fishalive-forensics.ts` + `out/fishalive-forensics.{md,json}` (+ resolution cache);
realized-PnL via `scripts/wallet-forensics.ts`. Read-only, keyless, no orders. Re-open only if a *fresh, multi-event*
fishalive track record (post-2026-06-15 activity across many independent fixtures) shows a credibly-graded, executable
edge — none exists today; the wallet is dormant after this one game.
