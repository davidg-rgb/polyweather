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
