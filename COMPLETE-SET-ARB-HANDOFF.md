# COMPLETE-SET-ARB — handover (going deeper tomorrow)

> Companion to `COMPLETE-SET-ARB.md` (the verdict). This is the "what to do next" note. The 8th signal
> is **MARGINAL → closed (fee-walled)**: the raw book is internally inconsistent ~16% of the time, but
> the `takerOnly` taker fee (~2–4%/ladder) is larger than the residual mispricing, so only 0.37% /
> 0.06% of instants clear, all in freshly-opened thin-book windows where depth is unmeasured. The
> verdict has **one genuinely-open hole** and a few sharpening moves. Rail stays DORMANT.

## State at handover (2026-06-24)

- **Built, tested, on disk** (uncommitted → committed this session on `feat/sports-copytrade`):
  - `packages/core/src/sim/complete-set-arb.ts` — pure model (+17 tests, full suite **1394 green**, typecheck clean).
  - `scripts/research/complete-set-arb-scan.ts` — historical scan → `scripts/research/out/complete-set-arb-scan.{json,md}`.
  - `scripts/research/complete-set-arb-live.ts` — live probe (keyless Gamma + CLOB, real depth).
  - `COMPLETE-SET-ARB.md` (verdict) + `FINDINGS.md` 8th-signal row (the row landed in commit `23196ee`).
- **Headline numbers:** 473 events / 43,776 contemporaneous instants; raw Σask<1 4.0%, Σbid>1 11.8%;
  fee-cleared 0.37% / 0.06%; best under +20.82% (Wuhan 6/24, freshly-opened thin book, Σask=0.77); live **0/107**.

## The ONE open hole — resolve this first

**The binding unknown is DEPTH/CAPACITY in the thin-open-book window.** The only fee-clearing
dislocations (Σask≪0.97) live in the first ~1–2 h of a freshly-opened ladder (lead ~2 d), and our
history has `book_top3 = null` there (the poller only attaches depth to ≤15 *candidate* books/cycle,
and thin early markets aren't candidates). So we know the **signal** is real but not whether it's
**executable at size** (5-share min × 11 fleeting legs, or real depth?).

**Move 1 — forward depth-capture (decisive).** Write a small read-only cron/script that, for every
ladder with `lead ≤ 2 d` and `age < 2 h`, fetches the **full** CLOB book for all buckets and logs
`Σ best-ask`, per-leg top-of-book depth, and `underroundExecutable` profit. Run it for a week. Then:
- if the Σask<0.97 windows carry real depth AND persist across consecutive captures → the thin-open
  window flips **MARGINAL → PASS** for small, capacity-bound size → design a complete-set executor
  (11-leg atomic-ish taker sweep, slippage budget, the negRisk redeem path).
- if depth is min-size / vanishes between captures → confirms capacity ≈ pennies → fully closed.
- The harness already exists: `complete-set-arb-live.ts` `underroundExecutable(books.map(b=>b.asks))`
  returns `{sets, costUsd, profitUsd}`. Just need the scheduled capture + a tiny table (or append-only
  JSONL) and the early-market filter.

## Sharpening moves (quick, do alongside)

**Move 2 — persistence on the historical clears (quick win, data already in DB).** For the 161+25
fee-cleared instants, add a window-function pass: were they ≥2 consecutive polls (executable) or
single-poll blips (gone before you assemble 11 legs)? One SQL pass over the existing
`market_snapshots`; folds straight into `complete-set-arb-scan.ts` as a `persistentClears` column.
Strong prior it's mostly blips — which would close the window even without Move 1.

**Move 3 — the fee-structure reopening monitor (cheap insurance).** The mechanical reopening trigger
is "the weather taker fee drops/restructures." Schedule `complete-set-arb-live.ts` (daily) and alert if
the `UNDER`/`OVER` count ever goes non-zero. That's the parallel of `reward-monitor.ts` for this lever
— it catches the one out-of-market event that un-walls the whole thing, for ~free.

## Bigger, genuinely-different branches (optional, separate investigations)

**Move 4 — cross-venue relative value (Kalshi ↔ Polymarket).** The truly unexplored adjacent lever:
the same city/day max-temp trades on **Kalshi** (CFTC-regulated) too. If the implied bucket probs
diverge beyond combined fees AND the resolution sources are compatible, that's a market-neutral
cross-venue arb that doesn't touch our forecast. Real lift: different bucket definitions, different
resolution station/source (Kalshi=NWS/CLI vs Polymarket=Wunderground — a divergence that is itself a
risk *and* an edge), Kalshi API access. Prior-art repo `suislanchez/polymarket-kalshi-weather-bot`
already pairs the two — read it first. This is the most promising untested *structural* direction left.

**Move 5 — negRisk mint-and-sell mechanics (close the overround properly).** The overround dual
(Σbid>1) was framed as "buy all NO" (taker-fee-walled) — but the textbook harvest is **mint** the
complete YES set for \$1 via the negRisk adapter and **sell** each leg into its bid. Verify: (a) the
real `NegRiskAdapter` split/convert path + any gas/mechanics cost; (b) whether a *marketable* sell
truly pays the `takerOnly` fee (it should — a crossing sell is a taker) vs a *resting* sell (maker, no
fee but adverse-selected). If resting sells on a fully-hedged complete set have *different*
adverse-selection than the single-bucket maker-spray wall (you hold the whole set, not a directional
leg), that's worth a clean measurement — it's the one place the "maker route re-opens the dead wall"
argument is not airtight.

## Don't re-do

- The stale-quote trap is handled: the ≤30-min contemporaneity gate (`isContemporaneous`/`MAX_STALE_MIN`)
  is non-negotiable — any new reconstruction MUST keep it, or it fabricates +100% phantom arbs (Karachi).
- The fee model is the live one (`takerFeePerShare`, weather_fees 0.05, `takerOnly`) — don't re-derive.
- The verdict criterion is frozen (`completeSetArbVerdict`, 2% standing bar) — don't move it to fit a result.

_Analytics record. Rail DORMANT. Nothing here is trading advice._
