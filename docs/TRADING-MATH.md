# TRADING-MATH — fees, edge, joint Kelly (worked examples match the code)

Every number below is asserted by the test suite; if the code drifts, the
suite breaks before this document lies.

## Taker fee (core/fees.ts)

`takerFeePerShare(p, rate) = rate · p · (1 − p)` — symmetric at p and 1−p.

**Worked example (the docs case, §15):** p = 0.34, rate = 0.05 →
0.05 · 0.34 · 0.66 = **0.01122/share** → 100 shares cost **$1.12** in fees.
`rate` comes from `market_buckets.fee_rate` (per market, captured from
`feeSchedule.rate`) — 0.05 appears in code only as the null-DB fallback.

## Minimum edge (core/fees.ts)

`minEdgeRequired = uncertaintyMargin + max(spreadBufferMin, spread/2) + takerFeePerShare(p, feeRate)`

Defaults: uncertaintyMargin 0.05, spreadBufferMin 0.01 (config table, §6.11).

## Edge (core/edge.ts)

`executableAsk` walks ask depth best-first for the probe stake ($20 default) —
EV uses the **walked average**, never top-of-book. `edge = q − execAsk`;
pass ⇔ `edge ≥ minEdge` and no liquidity veto (volume ≥ $2k, spread ≤ 0.05,
≥2h to local midnight, station verified, no halt).

## Joint Kelly (core/kelly.ts, ADR-08)

Candidates = PASSING buckets only, priced at the fee-adjusted effective cost
`p′ = execAsk + takerFeePerShare(execAsk, feeRate) + paperSlippage` (W4).
Greedy threshold solver: sort by q/p′, include while q/p′ > c with
`c = (1 − Σq_incl) / (1 − Σp′_incl)` recomputed per inclusion. Single bucket
reduces to `f* = (q − p′)/(1 − p′)`.

**Worked example (the poll-markets tick-1 test, real Seoul fixture):**
q = 0.55, execAsk = 0.27, fee = 0.05·0.27·0.73 = 0.009855, slippage = 0.01 →
p′ = 0.289855 → f* = (0.55 − 0.289855)/0.710145 = **0.366326**, c = 0.633673.
× kellyFraction 0.25 → 0.091581 → per-trade cap 2% of $1,000 bankroll = $20 →
floor(20/0.27) = **74 shares**, stake **$19.98**, capped_frac 0.01998.

## Risk caps (core/kelly.ts applyRiskCaps)

Clamp in order, shared headrooms depleting: per-trade 2% → per-event 5%
(incl. existing open) → cluster 8% → daily 15%; floor to whole shares
respecting orderMinSize (5); drop post-cap stakes < $5. Every clamp lands in
`capAudit[]` inside `bets.audit`. The fill-time twin lives in plpgsql
(`fill_bet_with_caps`, migration 0019) under `pg_advisory_xact_lock` — a
TS↔SQL parity test holds them to 4 decimal places.

## Fills and settlement

Paper fill = worse-of(stored exec ask, live re-walked book) + paperSlippage,
re-floored to the per-trade cap at the pessimistic price (W9). Settlement:
`pnl = (win ? shares·(1 − p) : −shares·p) − fee_total`, single ledger entry
per transition (ADR-09 partial-unique). Bankroll = Σ ledger per mode — never
a stored running balance (§7.16/W10).
