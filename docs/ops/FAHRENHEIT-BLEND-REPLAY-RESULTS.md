# Fahrenheit house-blend replay — results (2026-07-08)

**The ask (operator):** run the house-blend model vs the historic per-tick Polymarket book across all °F cities;
find every position whose price fits the house model's prediction for that day; simulate a **$10 buy at 10–15¢
within 24h of the position going live**, **sell at 30¢**; report **win-rate** and **net gain/loss**.

**Engine:** `scripts/research/fahrenheit-blend-replay.ts` (pure, read-only). Re-run: `pnpm tsx scripts/research/fahrenheit-blend-replay.ts`.

---

## Bottom line

| Metric | Result |
|---|---|
| °F markets with a predicted-bucket book series | 264 |
| **Positions entered** (predicted bucket at 10–15¢ within 24h of live) | **42** (avg entry **13.4¢**, 8.7h after live) |
| **Win-rate** (net-positive trades) | **42.9%** (18 of 42) |
| **Net P&L — maker exit** (30¢ resting limit, $0 fee) | **−$32.05** · ROI **−7.6%** · −$0.76/trade |
| **Net P&L — taker exit** (conservative, 5% fee both legs) | **−$46.27** · ROI **−11.0%** · −$1.10/trade |

**Verdict: the strategy loses money — narrowly, and for a clean reason.** Break-even needs a ~44.6% win-rate
(buy at 13.4¢, sell at 30¢ ⇒ +$12.4 per win must cover $10 per loss); we get **42.9%** — just under. The °F
market prices these cheap house-favored buckets almost exactly fairly, tipping slightly against us after fees.
This is the same efficiency verdict as the rest of the system, now measured on this exact play with the real book.

## Why it loses — the mechanism (this is the interesting part)

Outcome of the 42 entries:
- **18 sold at 30¢** (43% — the price popped to 30¢ and the resting sell filled) → these are the wins.
- **0 held and won** — because a bucket genuinely heading to $1 crosses 30¢ first, so it's booked as a 30¢ sale.
- **24 never reached 30¢ and resolved $0** → the losses.

The counterfactual makes the mechanism explicit — **hold every entry to resolution, no 30¢ TP:**
- The predicted cheap-entry bucket **actually wins only 4/42 = 9.5%** of the time.
- Hold-to-resolution net = **−$133.42 · ROI −31.8%** — **four times worse** than selling at 30¢.

So: cheap house-favored °F buckets **pop transiently** (43% touch 30¢) but **rarely deliver** (9.5% resolve as
winners). That gap is textbook **adverse selection** — the market prices these buckets cheap *because* they
usually lose, and it's right. The **30¢ take-profit is doing real work** (+$101 vs holding): it monetizes the
transient pop on the ~14 buckets that touch 30¢ then decay back toward $0. But even that protective exit can't
lift the play above break-even — the 24 outright losses ($−240) still outweigh the 18 capped wins.

## Per-city (net, maker exit)

| City | n | win% | sold@30¢ | net$ |
|---|---|---|---|---|
| KSFO | 5 | 80% | 4 | **+$32.15** |
| KDAL | 4 | 75% | 3 | **+$25.55** |
| KHOU | 1 | 100% | 1 | +$16.83 |
| KMIA | 1 | 100% | 1 | +$12.64 |
| KSEA | 7 | 57% | 4 | +$10.08 |
| KORD | 3 | 33% | 1 | −$1.30 |
| KAUS | 6 | 33% | 2 | −$14.34 |
| KATL | 2 | 0% | 0 | −$20.88 |
| KBKF | 6 | 17% | 1 | −$41.16 |
| KLGA | 7 | 14% | 1 | −$51.61 |

The city spread (KSFO/KDAL green, KLGA/KBKF deep red) is **not a signal** — it's best-of-10 noise at n=1–7/city,
the same `survivesMultipleComparisons: false` trap the system has hit before. It would not survive out-of-sample.

## Method notes / honesty

- **Book source:** `market_snapshots` (the poll-markets book, ~5-min cadence, persistent) — our most complete
  saved book covering **all** °F cities across each market's full life. (The local `opening-captures-archive` is
  finer-grained ~2-min but only covers the fresh-listed capture subset; `market_snapshots` is the comprehensive
  source and gives the full 42-position universe.)
- **Prediction:** the house blend = `house_gaussian`; the bucket = its **earliest** forecast argmax for the event
  (the forecast genuinely available within 24h of listing — no look-ahead).
- **No look-ahead:** entry = the first qualifying tick in time order; the exit walk starts strictly after entry
  and takes the first bid ≥ 0.30 (a later up-tick can't retro-fill).
- **"Live" anchor:** `market_events.first_seen` (first poll) — within ~a few hours of true listing (discover runs
  5×/day). Entry window = first 24h after that.
- **Sample:** 42 positions / 10 cities. Enough to read the mean honestly; per-city is not.

## What this means

The operator's specific, well-formed play (buy the house-favored °F bucket cheap, sell at 30¢) **is not
profitable** — 42.9% win-rate, ~−8% to −11% ROI — because the °F market is efficient w.r.t. the blend and the
cheap buckets are cheap for a reason (they win 9.5% of the time). This aligns with and sharpens the WS-A verdict
(`BUYING-BUILDS-LOOP.md`): the blend is far more *accurate* on °F than Google (88% vs 61% within-1), but that
accuracy is already in the price. No capital is warranted. If anything is worth a forward look it's the *exit*
insight — the 30¢ TP beats holding by 4× — but that improves a losing play, it doesn't make it a winner.

---

## Follow-up (2026-07-08): stop-loss + entry-ceiling sweep, no time limit — `fahrenheit-blend-sweep.ts`

Operator iteration: **add a stop-loss below 10¢**, **sweep the entry ceiling 15→20¢**, **remove the 24h entry
window**. I decomposed it into three configs × six bands on the same real book (no look-ahead), so each lever's
marginal effect is visible. Stop-loss = when the **mid** falls under 10¢, dump at the prevailing bid (taker);
TP = sell at 30¢ (maker); hold-to-resolution fallback.

| Config (entry 10–20¢ shown) | N | win% | net | ROI |
|---|---|---|---|---|
| **A — no stop-loss, 24h window** (baseline + wider entry) | 71 | **57.7%** | **−$7.55** | **−1.1%** |
| B — + stop-loss (mid<10¢), 24h window | 71 | 46.5% | −$36.05 | −5.1% |
| C — + stop-loss + **no** time limit *(the full request)* | 146 | 30.1% | −$375.15 | −25.7% |

Across the sweep (10–15¢ → 10–20¢): **A** improves −7.6% → **−1.1%**; **B** −16.4% → −5.1%; **C** −31.0% → −25.7%.

**What each lever does:**
- **Widening the entry ceiling (15→20¢) HELPS** — the single best result in the whole exercise is **A at 10–20¢:
  57.7% win, −1.1% ROI (near break-even).** Wider band catches more early-cheap winners (TP 18→41).
- **The stop-loss (below 10¢) HURTS** (~$35/band worse): these °F buckets are volatile and frequently dip below
  10¢ *transiently before recovering to the 30¢ TP*. The stop cuts those would-be winners at a low bid — it loses
  more from cutting recoveries than it saves from cutting losers early. A 10¢ stop is also far too tight under a
  10–20¢ entry (it fires on noise).
- **Removing the 24h window is CATASTROPHIC** (−26% to −31%): with no window, "first in-band ask ever" enters
  **late** (avg **27h** vs 9h) — buying buckets that were expensive early and *decayed* into 10–20¢ (falling
  knives). Combined with the stop, **~80% get stopped out**.

**Net:** the two new levers both make it worse; only the entry-widening (the third change) helps. The closest to
profitable in any variant is **buy 10–20¢, keep the 24h window, NO stop-loss, sell at 30¢ → −1.1% ROI, 57.7%
win** — still a (small) loss. The °F market remains efficient; no configuration tips it positive.

---

## Full ENTRY x EXIT grid — the pure flip, never hold to resolution (`fahrenheit-blend-grid.ts`)

Operator ask: find the best entry and exit, with the only rule being **buy cheap, sell slightly higher, never
hold to finish.** Model: buy the first tick the predicted bucket's ask lands in a band centred on E; sell (maker
limit) the first tick the bid reaches X; **if X never fills before resolution, DUMP at the last bid — no $1/$0
payout is collected.** Grid entry {5,10,15,20,25c} x exit {15,20,25,30,40,50c}, real book, no look-ahead.

**NET $ on $10 positions** (rows = buy ~Ec, cols = sell @ Xc):

| buy\sell | 15c | 20c | 25c | 30c | 40c | 50c |
|---|---|---|---|---|---|---|
| **5c**  | -$383 | -$277 | -$288 | -$423 | -$450 | -$470 |
| **10c** | -$457 | -$390 | -$463 | -$480 | -$554 | -$537 |
| **15c** | . | **-$261** | -$310 | -$328 | -$432 | -$439 |
| **20c** | . | . | -$320 | -$294 | -$347 | -$274 |
| **25c** | . | . | . | **-$267** | -$333 | -$302 |

**WIN %** (net-positive trades):

| buy\sell | 15c | 20c | 25c | 30c | 40c | 50c |
|---|---|---|---|---|---|---|
| **5c**  | 20% | 18% | 15% | 10% | 7% | 6% |
| **10c** | 40% | 34% | 23% | 18% | 13% | 13% |
| **15c** | . | 60% | 45% | 37% | 23% | 19% |
| **20c** | . | . | 63% | 54% | 38% | 33% |
| **25c** | . | . | . | **71%** | 49% | 40% |

**Best cells:** by ROI = **buy 25c / sell 30c -> 71% win, -$267 on 161 trades, -16.6% ROI**; by net$ = buy 15c /
sell 20c -> 60% win, -$261, -22.7%. **Every one of the 24 cells loses.**

**Why every flip loses:** the flip **caps the winner gain at the small (X-E) spread** while every non-completer
**dumps near $0**. Break-even needs flip-completion ~= 1/(1 + (X/E - 1)): buy 25c/sell 30c needs **83%**, buy
15c/sell 20c needs **75%** — the efficient market delivers only 71% / 60%. No cell clears its own bar. And it is
**strictly worse than holding to resolution** (-7.6% .. -1.1% above): *not holding* forfeits the $1 on the ~9.5%
of buckets that genuinely win, and those big wins are what kept the hold-to-resolution loss small. **Conclusion:
no profitable entry/exit exists for the flip — buying cheap and selling slightly higher on the °F markets loses
in every combination, because the market prices these buckets efficiently.**

---

## °C CONTRAST (C9, 2026-07-08) — the same grid on the bigger °C universe + the hold-to-resolution frontier

Operator follow-up: run the identical `fahrenheit-blend-grid.ts` shape on the **°C markets** (1045 resolved / 34
cities vs °F 396 / 11) "for contrast, maybe less efficient", and grid the **hold-to-resolution frontier**. The
engine is now unit-parameterized (`--unit F|C`, default F); the °F run above reproduces byte-for-byte (best
25c/30c -16.6%), so the refactor is faithful. Both added in one commit.

**1 · The pure FLIP is dead on °C too — all 24 cells lose** (best by ROI buy 25c/sell 30c -> 70% win, **-$934,
-16.8% ROI**; best by net$ buy 20c/sell 30c -> -$795, -17.8%). Essentially identical to °F (-16.6% / -22.7%). Same
mechanism: the flip caps the winner gain at (X-E) while non-completers dump near $0; the market delivers ~70%
completion where break-even needs ~83%. **Flipping is efficient in both units.**

**2 · The HOLD-TO-RESOLUTION frontier is where °C differs — and it is marginally NON-negative at 20c:**

| buy band | n | win% | net$ | ROI |
|---|---|---|---|---|
| 5c | 275 | 5% | -$298 | -10.8% |
| 10c | 318 | 9% | -$446 | -14.0% |
| 15c | 381 | 14% | -$362 | -9.5% |
| **20c** | **447** | **21%** | **+$50** | **+1.1%** |
| 25c | 556 | 26% | -$42 | -0.8% |

The **20c hold band is +1.1% (+$50 / 447 markets)** and 25c is near-breakeven (-0.8%) — the **first non-negative
hold result across °F/°C** (°F's best hold was **-1.1%** at 10-20c, C6). So °C is *slightly less efficient than °F*
at the ~20c hold: the house-blend's predicted bucket, bought at ~20c and held for $1/$0, wins 21% — just enough to
cover a 20c ask.

**⚠ NOT AN EDGE YET — this is a raw, ungated point estimate.** +1.1% on 447 markets is +$50 on $4,470 deployed: a
razor-thin margin that has **not** been clustered or null-tested. Per the frozen-gate discipline (rule 3; the whole
12-signal graveyard is "a point estimate that didn't survive the gate"), before this is anything more than
"interesting" it must clear: (a) a **city-clustered** 95% CI on mean net-return with `ciLow > 0` (34 cities, not
447 i.i.d. bets — same-day weather correlates), and (b) the **zero-skill sign-flip MC < 5%**. The strong prior is
the clustered CI straddles zero at +1.1%. **C10 = run the °C 20c-hold band through `openingVerdict` / the §9R-E
gate; only a clustered ciLow>0 promotes it.** Until then: interesting contrast, not a signal.
