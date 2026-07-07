# Karachi live city-taker — the entry-hour decision (pre-funding gate)

> **Written 2026-07-07 (C101), operator-directed.** The operator authorized a LIVE $5/day city-taker test on
> Karachi (buy our forecast bucket once/day, hold to resolution) and asked, before funding, to **establish the
> best betting hour** — the hour that combines our predictive accuracy with the lowest **avg buy price** — and
> to **establish that we can actually purchase at each relevant hour**. This is the answer, on REAL executable
> book data. Boundary intact: no capital moved, no key touched — this is analysis of record.

## TL;DR

1. **Accuracy does not vary by hour.** Our bucket is picked once per day; the hit rate is **event-level, 51.0%
   (l0, n=49)**. The per-hour hit-rate wobble in the MID analysis is *survivorship* (some markets resolve before
   noon), not a real accuracy signal. So the operator's "high-accuracy hour" doesn't exist — **the only lever the
   hour gives you is the price.** EV per $1 = `accuracy / buy_price − 1` → **buy at the cheapest executable hour.**
2. **Best executable hour = 10:00–11:00 Karachi (= 05:00–06:00 UTC), NOT 14:00.** On the real $5-order ask the
   winner-band bucket is cheapest here (~**45¢**, EV **+0.14** at 51% accuracy), still fillable 9/10. **14:00 —
   the currently-planned live hour — is the WORST of the tradable window: real ask ~52¢, EV −0.02** (breakeven-
   negative). The single highest-value change before funding: **set the live arm's `entry_hour_override` 14 → 11.**
3. **Purchasability: YES for every hour worth buying.** The book is live, deep, and tight from **01:00–15:00
   Karachi** (≥7/10 events fillable, 90% of asks carry ≥$5 depth). It **vanishes 16:00–23:00** (≤4/10 fillable,
   depth ≈ $0 — the post-convergence corpse). We cannot buy at *all* hours, but we can buy at every *cheap* hour.
4. **Caveat that caps everything: this is knife-edge and efficient.** The real ask ≈ our accuracy at essentially
   every tradable hour (~50¢ ≈ 51%). The +0.14 at 10–11 rests on 51% accuracy (older 49-event set) applied to the
   10 recent real-book events, whose *own* model confidence (`houseProb`) is only ~46–48%. If true accuracy is
   ~47%, 10–11 → ~+0.05 and everything else is negative. **$5/day at 11:00 is buying information at ~breakeven,
   not capturing a proven edge** — consistent with the twelve-signal efficiency verdict. 11:00 is the *least-bad*
   hour, decisively better than 14:00.

## The two data sources (and why they don't fully join)

| | events | price type | has winner? | has our-bucket? |
|:--|:--|:--|:--|:--|
| `market-history/karachi` (Test 1 substrate) | **49** resolved | **MID** only (~1-min) | ✅ | ✅ via `forecast-by-event.csv` (l0) |
| `opening-captures-archive` (real book) | **10** recent (~1 week) | **bid/ask + execAsk + depth** | ❌ (0/10 in market-history) | ✅ via `argmax(houseProb)` = the bot's pick |

The stale Jun-30 forecast CSV has **zero overlap** with the 10 recent archive events, and those 10 aren't yet in
market-history — so accuracy (needs winner+forecast) and real ask (needs the live book) live in **different event
sets**. Bridge: accuracy is event-level and ~stationary → take **51%** from the 49-event set; take **real price by
hour** from the 10-event book, using `argmax(houseProb)` as "our bucket" (that IS what the live lane buys). The
`houseProb` on those events averages **46–48%**, close enough to 51% to make the bridge honest — and to flag the
knife-edge.

## Buy price for a $5 order (the important subtlety)

`execAsk` in the archive = the VWAP to fill **$20** (`probeStakeUsd`, `packages/core/src/edge.ts`), walking the
book best-first. Our live stake is **$5** — it fills the top of the book and stops earlier, so its cost is between
`bestAsk` and the $20 `execAsk`, and **much closer to `bestAsk`** whenever ≥$5 sits at the top level (90% of the
time here). So the **$5 buy price ≈ `bestAsk`**; `execAsk` is a conservative upper bound (relevant only if you
scale the stake up). This is why 14:00 looks like −0.29 on the $20 probe but is only **−0.02 for a $5 order** —
the −0.29 was $20 walking a thin near-resolution book, not our size.

## Decision table — accuracy 51% vs real $5-order buy price, by Karachi local hour

`EV_$5 = 0.51 / bestAsk − 1`. Purchasable = fraction of the 10 events with a fillable book (`execAsk>0 & depth≥$5`).

| Karachi hr | UTC | nEv | fillable | avg bestAsk ($5 price) | avg execAsk ($20) | avg mid | EV_$5 | purchasable? |
|---:|---:|---:|---:|---:|---:|---:|---:|:--|
| 01:00 | 20:00 | 7 | 7/7 | 53.7¢ | 53.6¢ | 52.6¢ | −0.051 | YES (deep) |
| 02:00 | 21:00 | 7 | 7/7 | 55.1¢ | 55.4¢ | 54.1¢ | −0.075 | YES (deep) |
| 03:00 | 22:00 | 8 | 8/8 | 53.4¢ | 53.7¢ | 52.5¢ | −0.044 | YES (deep) |
| 04:00 | 23:00 | 8 | 8/8 | 49.5¢ | 49.4¢ | 48.6¢ | +0.030 | YES (deep) |
| 05:00 | 00:00 | 8 | 8/8 | 49.0¢ | 49.4¢ | 47.6¢ | +0.041 | YES (deep) |
| 06:00 | 01:00 | 8 | 8/8 | 50.4¢ | 51.1¢ | 49.3¢ | +0.012 | YES (deep) |
| 07:00 | 02:00 | 7 | 7/7 | 54.0¢ | 54.6¢ | 52.9¢ | −0.056 | YES (deep) |
| 08:00 | 03:00 | 7 | 7/7 | 56.0¢ | 56.3¢ | 53.9¢ | −0.089 | YES (deep) |
| 09:00 | 04:00 | 7 | 7/7 | 55.4¢ | 55.4¢ | 52.6¢ | −0.080 | YES (deep) |
| **10:00** | **05:00** | 10 | 9/10 | **44.9¢** | 48.1¢ | 42.2¢ | **+0.136** | yes |
| **11:00** | **06:00** | 10 | 9/10 | **44.8¢** | 48.5¢ | 41.5¢ | **+0.138** | YES (deep) |
| 12:00 | 07:00 | 10 | 9/10 | 48.6¢ | 50.6¢ | 46.2¢ | +0.049 | YES (deep) |
| 13:00 | 08:00 | 10 | 8/10 | 48.2¢ | 56.8¢ | 45.7¢ | +0.058 | YES (deep) |
| **14:00** | **09:00** | 10 | 7/10 | 52.0¢ | 72.1¢ | 55.8¢ | **−0.019** | YES (deep) |
| 15:00 | 10:00 | 10 | 7/10 | 52.3¢ | 71.8¢ | 57.3¢ | −0.025 | YES (deep) |
| 16:00 | 11:00 | 10 | 4/10 | 48.9¢ | 69.2¢ | 60.6¢ | (+0.044) | **NO** — book gone |
| 17:00 | 12:00 | 10 | 4/10 | 48.8¢ | 72.8¢ | 60.7¢ | (+0.045) | **NO** |
| 18:00–20:00 | 13–15:00 | 10 | 2–3/10 | ~54¢ | ~67¢ | 77–90¢ | — | **NO** |
| 21:00–23:00 | 16–18:00 | 9–10 | 0–1/10 | ~55¢ | — | 90–100¢ | — | **NO** |

_(00:00 row dropped — n=1, a single stale 26¢ quote, not real.)_ Top executable hours by EV_$5: **11:00 (+0.138),
10:00 (+0.136),** 13:00 (+0.058), 12:00 (+0.049). 14:00 ranks near the bottom of the tradable set.

## Why 14:00 is the wrong default (reconciling with the paper WATCH)

The paper WATCH recommended arm 14 because on the **MID, no-fee, event-level** paper sim, 14:00 had the best
95%-LB edge among arms {10..15}. But the paper sim never prices the **real ask premium** at 14:00: by early
afternoon the market has converged, the winner's near-resolution book is thin at the top, and the real ask carries
a fat premium over mid (52¢ ask vs 56¢ mid, and the $20 walk hits 72¢). Move the entry to late morning (10–11) and
you buy the *same fixed-accuracy bucket* ~7¢ cheaper on the real ask. **The real book overturns the paper 14:00
pick in favor of 10–11.**

The "cheap-entry ~21¢ on MID" from the C100 re-test is a **MID illusion**: the executable ask for our bucket never
gets near 21¢ — its real floor is ~45¢ (10–11h). Confirmed here on the book.

## Recommendation (operator-physical; Claude does not toggle)

1. **If funding the live test: set the Karachi live arm `entry_hour_override` = 11** (or 10). 11:00 Karachi =
   **06:00 UTC**. Cheapest executable hour, +EV on the real $5 ask, still deep/fillable, and **inside the existing
   window — no `arm_hours` change needed** (`arm_hours=[10..15]` already covers 11; item (c) is moot at 11).
   Earliest placement then becomes **07-08 06:00Z**, three hours earlier than the 14:00=09:00Z plan.
2. **Do not chase the overnight 04–06 window.** It's the deepest/tightest book but only ~breakeven (+0.01/+0.04)
   and *outside* `arm_hours` — 10–11 is both cheaper and already in-window. Not worth an `arm_hours` migration.
3. **Size the expectation honestly.** Even at 11:00 the edge is ~+0.14 *if* accuracy is 51%, ~+0.05 *if* it's the
   events' own ~47% `houseProb`, on **10 events / 1 week**. Treat $5/day as **buying information at ~breakeven**,
   11:00 being the least-bad hour — not a proven edge. This does not reopen the efficiency verdict.

## Reproduce

Real-book aggregation over `scripts/research/out/opening-captures-archive` (the frozen bid/ask dump): our bucket =
`argmax(houseProb)` per capture, per Karachi-local hour keep the last capture; report `bestAsk`/`execAsk`/`mid`/
`depthUsd`/fillable. Accuracy 51% from `pnpm tsx scripts/research/karachi-entry-time.ts` (l0, 49 events). The
one-shot recon lives in the session scratchpad (`karachi_best_hour.py`); promote to a tested `scripts/research/
karachi-best-hour.ts` if this becomes a recurring read rather than a one-time pre-funding decision.
