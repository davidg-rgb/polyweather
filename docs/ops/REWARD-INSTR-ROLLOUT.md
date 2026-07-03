# REWARD-INSTR rollout — reward-eligibility tick diagnostic on the forward maker-exit loop

> The operator-greenlit follow-on to SIGNAL-BACKLOG item 1b (gate-PASS with the pool-share unmeasured):
> instrument the live paper loop to measure the OBSERVABLE eligibility input — `qualifyingTickFrac` =
> (resting-TP ticks whose prior-tick mid puts the sell in the 4.5 ¢ reward band) / (all resting-TP ticks),
> tick-weighted across realized trades. **Diagnostic only: no assumed share, no dollars, the §9R-E gate
> math is byte-identical** (existing tests unchanged; suite 135 files / 1934 green incl. +6 new).
> Engine → view (`MakerExitAssumptions` #4) → `maker_exit_panel.view` jsonb (NO migration — 0073's jsonb
> round-trips new fields) → `/maker-exit` tile #4. Pool-context (market_rewards join) deliberately
> deferred (conditionId↔eventId plumbing disproportionate; the frac is the decision-relevant number).

## Deploy (2 steps, either order; avoid :30–:42 so a mid-tick fn swap can't clip the hourly :35 run)

1. **Edge fn:** `npx --no-install supabase functions deploy maker-exit-panel --use-api --project-ref lenysiqxihsmxljvyybt`
2. **Web:** push `main` → Vercel auto-builds `weather-edge-two.vercel.app`.

## Verify (after the next :35 tick)

- `select stats from job_runs where job='maker-exit-panel' order by started_at desc limit 1;`
  → `stats.qualifyingTickFrac` present (number or null; null only if zero realized trades) alongside
  `makerFillRate`; tick still ok/<~120 s/cityErrors ≤2/nMarkets ≥40.
- `select view->'assumptions' from maker_exit_panel order by id desc limit 1;`
  → carries `qualifyingTickFrac`, `nQualifyingRestingTicks`, `nRestingTicks`.
- `/maker-exit` shows headline tile **#4 · Reward-qualifying ticks** (em-dash on pre-deploy snapshots is
  correct behavior, not a bug).

## Rollback

- Fn: redeploy from the pre-merge commit (`git checkout 4669c5c -- supabase/functions/maker-exit-panel` →
  deploy → `git checkout main -- ...`). Old snapshots are unaffected either way (additive jsonb).
- Web: Vercel → promote the previous deployment.

## How to read the number

`qualifyingTickFrac` bounds the reward-income term of the 1b backtest: income ≈ frac × poolUsd/day ×
share × resting-time. The backtest's CI improvement (ciLow +0.25 %→+2.38 % at share 0.05) assumed the TP
rests in-band; a low live frac shrinks that term proportionally BEFORE the share question even opens.
It does not change the forward gate's PASS/KILL math — adjudication stays `POST-FABLE-HANDOFF.md`.

---

## v2 — the "WHY zero" pool-context extension (2026-07-04)

> Built after the first deployed read came back **`qualifyingTickFrac = 0` (0 of 1,732 resting ticks)**:
> the frac says the resting TP never qualifies, but not WHY. v2 decomposes the disqualification per
> resting tick — same hard constraints as v1: **additive-diagnostic only, §9R-E gate math byte-identical**
> (every pre-existing test unchanged + green), jsonb-additive (NO migration — 0073 round-trips the new
> fields), no new heavy read (everything computes from the capture/replay stream the handler already loads).
> Same wire path: engine (`MakerExitTrade` per-trade accumulators → `replayMakerExitPanel` aggregate) →
> view (`MakerExitAssumptions` #4b) → `maker_exit_panel.view` jsonb → `/maker-exit` tile #4 WHY sub-line.

### The four new fields (in `view->'assumptions'` and on tile #4)

| Field | Semantics | Denominator |
|---|---|---|
| `meanDistFromMidPp` | mean \|resting-sell price − prior-tick mid\| in cents/pp | **mid-known resting ticks** only — a tick whose prior mid is missing contributes nothing (never fabricated) |
| `fracWithinAdvertisedBand` | fraction of ticks where that distance ≤ the band threshold — the PRICE-BAND half of the eligibility formula ONLY | **mid-known resting ticks** |
| `fracFailsMinSize` | fraction of ticks whose trade's share count (`stakeUsd/entryPrice`) sits below the min-size floor — binary per trade (shares never change while resting), so each trade contributes 0 or all of its ticks | **all resting ticks** |
| `dominantDisqualifier` | one-line read: `band` \| `size` \| `both` \| `none` (see below) | — |

All are tick-weighted across REALIZED trades, no-look-ahead (prior-tick mid), pool-SHARE-agnostic —
identical conventions to v1's `qualifyingTickFrac`. NaN (page: em-dash) when the denominator is 0.

### The two thresholds are FIXED DEFAULTS today — not live per-market reads

- **Band:** `cfg.rewardCfg?.maxSpreadCents ?? 4.5` — and the live paper loop runs with **no `rewardCfg`
  configured**, so in production this is **ALWAYS the 4.5 ¢ REC-3 weather-universal default**, never a
  per-market `market_rewards.max_spread` read (the join stays deliberately deferred, v1 header above).
- **Min size:** `REWARD_ELIGIBILITY_MIN_SIZE_SHARES = 50` — a **permanent cross-market constant** with
  **no live per-market read at all** (`MakerExitCfg.rewardCfg` has no `minSize` field; there is no code
  path that can substitute a market's real value). Source: the REC-3-observed weather default
  (MAKER-REBATE-HANDOFF §9; `reward-probe.ts` uses the same 50-share fallback).
- **Misclassification this can cause:** any market whose real `rewards.min_size` differs from 50 (REC-3
  also observed 20 on some markets) or whose `max_spread` differs from 4.5 ¢ gets scored against the wrong
  floor/band — `fracFailsMinSize` can over-count (real floor 20, our stake 30–49 shares → flagged as
  failing though it actually qualifies) and `fracWithinAdvertisedBand` can mis-band in either direction.
  Treat both fractions as **against-the-default diagnostics**, not per-market advertised truth. If this
  diagnostic ever escalates to a $ decision, build the `market_rewards` join first.

### `dominantDisqualifier` — the rule and the `'none'` reading

Symmetric **strict-majority-fails** on both axes: an axis "fails" iff its failing fraction **strictly
exceeds 0.5** (band fails when `1 − fracWithinAdvertisedBand > 0.5`; size fails when
`fracFailsMinSize > 0.5`; an exact 50/50 tie on either axis resolves to NOT-failing). `both` = both
strictly majority-failing; `none` = neither is.

**`none` with a low/zero `qualifyingTickFrac` is the informative case:** band and size both mostly PASS,
yet the order still never qualifies — the residual cause is Polymarket's strict two-sided **mid-regime
rule** (mid < 0.10 or > 0.90 ⇒ a one-sided quote scores ZERO regardless of band/size; `restingSellQmin` /
`reward-farming.ts` docs-verbatim). **This is the documented reading of the live 0/1,732:** the maker-exit
enters cheap buckets (tuned maxEntryPrice 0.30, typical fills far lower) whose mids sit under 0.10 for
most of the rest — exactly `reward-farming.ts`'s own "MOST weather buckets sit < 0.10 (cheap longshots)"
regime, where one-sided resting orders earn nothing. v2 does NOT decompose the regime case further —
`none` is the signal to look there.

### Verify additions (on top of the v1 checklist)

- `select stats->>'dominantDisqualifier' from job_runs where job='maker-exit-panel' order by started_at desc limit 1;`
  → one of `band|size|both|none` (`none` also when zero resting ticks accrued — same honesty as the NaN frac).
- `select view->'assumptions' from maker_exit_panel order by id desc limit 1;` → additionally carries
  `meanDistFromMidPp`, `fracWithinAdvertisedBand`, `fracFailsMinSize`, `dominantDisqualifier`.
- `/maker-exit` tile #4 shows the WHY sub-line (em-dash fields on pre-deploy snapshots = correct, not a bug),
  with the fixed-defaults caption "(vs 4.5¢ default band · 50-share min)".
