# COMPLETE-SET-ARB — the structural (forecast-free) arbitrage, and the fee wall that closes it

> **The 8th signal.** Every prior falsification (`FINDINGS.md`) tested one question: *is our forecast
> better than the market?* This document tests the **orthogonal** one nobody had: *is the market
> consistent with **itself**?* It is the one net-positive **mechanism** the R&D program never ran —
> and the only one that needs **zero forecast skill**. Authored 2026-06-24 · read-only R&D record ·
> status **CLOSED (fee-walled; rail stays DORMANT)**.

---

## Bottom line, up front

**No net-positive path here either — but it dies to a *different* wall than the seven forecast
signals.** Those died to **efficiency** (the market forecasts as well as or better than we can). This
one is not about forecasting at all: a daily-Tmax event is a negRisk ladder of N mutually-exclusive,
collectively-exhaustive buckets where **exactly one** pays \$1. So with no model whatsoever:

- a complete set of one **YES** per bucket is worth **exactly \$1** at resolution;
- a complete set of one **NO** per bucket is worth **exactly \$(N−1)**.

Two dual, riskless, **buy-and-hold** trades follow (no minting, no sells, no inventory marked to a
0/1 outcome — a *deterministic* payoff):

| | condition | trade | net per \$1 set |
|---|---|---|---|
| **UNDERROUND** | Σ ask(YESᵢ) < 1 | buy every YES, hold → collect \$1 | `1 − Σask` |
| **OVERROUND** | Σ bid(YESᵢ) > 1 (⟺ Σ ask(NOᵢ) < N−1) | buy every NO, hold → collect \$(N−1) | `Σbid − 1` |

Market efficiency w.r.t. a forecast is **irrelevant** — this is an accounting identity. The only
questions are *frequency*, *fee*, and *executable depth*. The measurement (full resolved-ladder
universe + a live probe of every open ladder):

> **The raw book IS internally inconsistent a meaningful fraction of the time — Σask<1 on ~4.0% of
> contemporaneous instants, Σbid>1 on ~11.8% — but the per-leg `takerOnly` taker fee (~2–4% of a \$1
> ladder) is LARGER than the residual mispricing. After fees only 0.37% / 0.06% of instants clear, and
> those survivors live almost entirely in the freshly-opened thin-book window where depth is the
> min-order-size (capacity ≈ pennies). A live probe of all 107 open ladders found 0 fee-clearing
> dislocations. The maker route that would dodge the taker fee re-introduces the adverse-selection
> wall already falsified seven times. The structural lever is FEE-WALLED.** → **MARGINAL** (real but
> capacity-bound), not net-positive. Rail stays DORMANT.

This is the genuinely-distinct, never-tested lever that the prior-art research had flagged in one
high-confidence aside — *"NegRisk enables laddering and occasional sum-of-YES < \$1.00 arb on thin
internationals"* (`research/REPORT-strategy-prior-art.md` §2d) — and that the whole forecast-alpha
program then walked straight past. Now measured, and closed.

---

## Why it's orthogonal to all seven prior falsifications

| Every falsified signal (`FINDINGS.md`) | Complete-set arbitrage |
|---|---|
| Needs a forecast edge | **Needs zero forecast skill** |
| Directional → adverse selection on fills | **Market-neutral → no adverse selection** |
| "Is our model better than the market?" | **"Is the market consistent with itself?"** |
| Killed by **efficiency** | Efficiency is irrelevant — killed by the **fee wall** |

A complete-set position has a *deterministic* payoff: the day's max lands in exactly one bucket, so a
full YES ladder pays \$1 and a full NO ladder pays \$(N−1) **regardless of which bucket wins**. There
is no outcome risk to be adversely selected on — the only adversary is the fee schedule.

---

## The measurement

### Data
`market_snapshots` over the full backfill: **827 resolved + ladder-verified events** (a `ladder_ok`
flag guarantees the "exactly one bucket wins" invariant), **674,769** per-bucket best-bid/ask
snapshots, 2026-05-14 → 2026-06-24. Plus a **live** read of every currently-open ladder via the
keyless Gamma + CLOB APIs.

### The stale-quote trap (the load-bearing methodology fix)
`market_snapshots` is **delta-deduped + heartbeated**: `poll-markets` writes a bucket row only on a
≥0.5¢ mid move **or** every 30 min (candidate ladder) / 2 h (otherwise). So an un-rewritten quote is
the live resting quote **only within its heartbeat window**; beyond it the poller stopped covering the
leg and the carried value is a **ghost**.

A naive forward-fill (carry each leg's last quote forever) fabricates the entire signal. The first
pass produced a **+137% "arb"** on Karachi — dissection showed it was Σbid = 2.38 stitched from a
**4.5-hour-stale** 0.979 bid and a **5.7-hour-stale** 0.389 bid that were long gone from the live book
by the time the winning bucket had locked. The honest measurement requires a **contemporaneity gate**:
every leg quoted within ≤30 min (the candidate heartbeat) of the instant. With that gate, the phantom
dislocations vanish. This is the same discipline that made REC-10 trustworthy — *measure the real
executable state, don't assume it.* (Codified as `isContemporaneous` / `MAX_STALE_MIN`.)

### Result — historical (full universe, `complete-set-arb-scan.ts`, ≤30-min gate)

```
473 events with a contemporaneous complete-set · 43,776 fresh instants

RAW book inconsistency (pre-fee):
  Σask < 1 (underround):  1,767 / 43,776   (4.04%)
  Σbid > 1 (overround):   5,174 / 43,776   (11.82%)

AFTER the per-leg taker fee (weather_fees 0.05, takerOnly — the wall):
  underround NET > 0:       161 / 43,776   (0.37%)
  overround  NET > 0:        25 / 43,776   (0.06%)
  best underround net 20.82% · best overround net 2.35% · mean underround net −15.11%
```

The fee wall removes **~91%** of the raw underround opportunities and **~99.5%** of the raw overround
ones. The fee-cleared residue concentrates in a handful of events (Wuhan 6/24 +20.82%, Seattle 6/23
34 cleared instants, Manila 6/23 7) — every one a **freshly-opened thin book** where Σask collapses
far below 1 because market-makers have not yet populated the ladder. Wuhan's peak: Σask = **0.77**
with all legs fresh — a genuine +20.8% net dislocation. But `book_top3` is `null` on every leg there
(the poller only attaches depth to ≤15 candidate books/cycle, and thin early markets aren't
candidates), so historical data captures the **signal** but not the **capacity**.

### Result — live (`complete-set-arb-live.ts`, all open ladders, full CLOB depth)

```
107 open temperature ladders · top-of-book dislocations: UNDER 0/107 · OVER 0/107
nearest misses: chengdu Σask=0.981 → underNet −1.25% ; miami Σask=1.011 → −1.16%
```

Live, **0 of 107** open ladders clear the fee. And the near-misses pin the mechanism exactly: chengdu
and chongqing show **Σask < 1 raw** (a real ~1–2% underround), yet `underNet` is still negative
because the 11-leg taker fee (~2.5–3%) exceeds the raw gap. The book is internally consistent **to
within the fee**, not to the penny.

---

## Why the fee is the wall (and why the obvious dodges don't work)

- **`takerOnly: true`.** The weather fee `rate·p·(1−p)` is charged to **takers**. Both riskless trades
  are aggressive (taker) **buys** — the only guaranteed-execution way to assemble a complete set — so
  they pay the wall. Summed across a full ladder the fee is ~2–4% of a \$1 set; the residual raw
  mispricing is smaller.
- **Maker route (dodge the fee).** Rest the legs as maker bids → pay no fee. But then you only fill the
  legs the book *comes to*, which on a binary that resolves 0/1 is the legs that move **against** you —
  the **adverse-selection wall** already measured and rejected seven times (`maker-spray`,
  `reward-inventory`, the badatmath replica). Dodging the taker fee re-opens the dead lever.
- **Mint-and-sell (the overround).** Minting a complete YES set for \$1 and selling each leg into its
  bid would harvest Σbid − 1 — but a *marketable* sell is itself a taker fill (the `takerOnly` fee
  applies), and a *resting* sell is the maker/adverse-selection wall again. Either way it is closed;
  the raw overround (max +2.35% over the whole universe, 1 instant) never clears even before that.
- **Thin-open-book window (where the raw dislocation is deep enough).** Σask ≈ 0.77 *does* clear the
  fee handsomely — but it exists for a brief window on a freshly-opened ladder, at top-of-book depth
  that is the **min-order-size** (capacity ≈ a few dollars per leg), across 11 legs that must each
  still be there when you hit them. Real, but not scalable to meaningful capital, and unverifiable for
  depth from our history.

---

## Verdict & the reopening condition

**MARGINAL → treated as closed.** The structural complete-set arbitrage is **real at the raw-price
level** (the book is genuinely inconsistent ~16% of the time) but **net-negative for a taker** because
the `takerOnly` fee is larger than the residual mispricing; the only fee-clearing windows are
thin-open-book, capacity ≈ pennies; the fee-dodging maker route is the already-dead adverse-selection
wall. There is no net-positive structural path. **This closes the last orthogonal mechanism** — every
*forecast* signal was efficient, and now the one *structural* signal is fee-walled.

**The reopening condition (frozen, parallel to the reward-funding clause).** This lever re-opens only
on genuinely-out-of-market information of one kind:

1. **Polymarket drops or restructures the weather taker fee** (the 0%-fee era ended March 2026; a
   reversal or a maker-only/under-some-threshold carve-out would un-wall it). The reopening trigger is
   mechanical: `scripts/research/complete-set-arb-live.ts` flips to a non-zero `UNDER`/`OVER` count.
2. **A depth study proves the thin-open-book window is executable at size** — i.e. capture full
   `book_top3` on the freshly-opened ladders (lead ~2 d, first hour) and show the Σask<0.97
   dislocations carry real depth and persist across consecutive polls. Today's data can't answer this
   (depth is `null` in exactly that window); a forward depth-capture cron could.

Re-run anytime: `pnpm tsx scripts/research/complete-set-arb-live.ts` (live) and
`pnpm tsx scripts/research/complete-set-arb-scan.ts` (history). The rail stays **DORMANT**.

---

---

## Forward depth-capture (Moves 1/2/3 — built 2026-06-25, pending operator deploy)

The original scan established the SIGNAL (161 fee-cleared instants, all in freshly-opened thin-book windows)
but not the CAPACITY (book_top3 is NULL in exactly those windows in market_snapshots). Three follow-up moves
resolve this — all built and tested on branch `agent/arb-depth-capture`, suite **1402 green**:

**Move 1 — forward depth-capture (decisive, ~7-day runway).**
`complete_set_depth_captures` (migration 0060) + `arb-depth-capture` Edge Function (every 30 min).
Filters to open ladders with lead≤2d, fetches the full CLOB book for every bucket, computes `exec_sets`
(profit-maximising whole sets at depth), and logs the result. After a week:
- `exec_sets > 0` on a `fee_cleared` row AND `classifyPersistence` shows ≥2 consecutive polls → escalate.
- `exec_sets == 0` always → capacity ≈ min-order-size → fully closed.
Read: `SELECT dash_complete_set_depth(7)` or call the RPC from the operator dashboard.

**Move 2 — persistence classifier (code-only, runs over historical data).**
`classifyPersistence` in `packages/core/src/sim/complete-set-arb.ts` classifies each clearing instant as
`persistent` (≥2 consecutive polls) or `singlePollBlip`. `complete-set-arb-scan.ts` now prints a
persistence section. Strong prior: mostly blips — if confirmed, the window closes independently of depth.
Re-run: `pnpm tsx scripts/research/complete-set-arb-scan.ts` (needs DB connection).

**Move 3 — fee-structure reopening monitor (embedded in Move 1 tick, daily at UTC 10h).**
Top-of-book check over all open ladders. Slack-alerts kind `ARB_REOPEN` if any ladder shows `fee_cleared`.
This is the mechanical trigger for a Polymarket fee restructure — the one out-of-market event that un-walls
the whole signal. No additional deploy needed: it's part of the `arb-depth-capture` Edge tick.

**Operator go-live steps** (all three moves go live together):
```bash
# 1. Apply migration
supabase migration apply --file supabase/migrations/0060_complete_set_depth_capture.sql
# 2. Deploy edge function
npx supabase functions deploy arb-depth-capture --use-api --project-ref lenysiqxihsmxljvyybt
# 3. Verify cron
select jobname, schedule from cron.job where jobname = 'arb-depth-capture';
# 4. Verify first capture (after 30 min)
select count(*) from complete_set_depth_captures;
```

---

## Where it lives

| Piece | Path |
|---|---|
| Pure model + frozen verdict + `classifyPersistence` (Move 2) | `packages/core/src/sim/complete-set-arb.ts` |
| Tests (26: 17 original + 9 persistence) | `packages/core/test/complete-set-arb.test.ts` |
| Historical scan spine + Move 2 persistence columns | `scripts/research/complete-set-arb-scan.ts` |
| Live probe (open ladders + CLOB depth) | `scripts/research/complete-set-arb-live.ts` |
| Move 1 depth-capture table + RPC + cron | `supabase/migrations/0060_complete_set_depth_capture.sql` |
| Move 1+3 Edge Function | `supabase/functions/arb-depth-capture/{index,handler}.ts` |
| Handover + next-steps | `COMPLETE-SET-ARB-HANDOFF.md` |
| The prior-art aside that named it | `research/REPORT-strategy-prior-art.md` §2d, §3 |

_Analytics & forecasting record. Nothing here is trading advice; the live rail is DORMANT._
