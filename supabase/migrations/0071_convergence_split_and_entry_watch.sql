-- 0071_convergence_split_and_entry_watch.sql — the convergence/accuracy forecast SPLIT + the paper-trade
-- entry-time WATCHER's wider arm race (operator ask, 2026-06-29).
--
-- TWO independent, additive changes — no schema, no function bodies, only config/seed data:
--
-- 1. THE CONVERGENCE/ACCURACY SPLIT (ops mirror). The opening-convergence bot's house seed now centers on
--    the RAW cross-model consensus — what the crowd's weather apps show, the Schelling point a freshly-listed
--    market converges to — NOT our accuracy-tuned (bias-corrected) forecast. A −1°C "truth" correction that
--    wins the held-to-resolution paper-trade LOSES the convergence (it moves us off the crowd's center). The
--    code default lives in packages/core BOT_DEFAULTS.consensusSource='ensemble_raw' (authoritative, parsed by
--    parseBotConfig + applied in opening-capture/seed via buildDistributionForEvent's biasCorrect flag); this
--    row is the operator-tunable MIRROR (same F10-r8-FP contract as the rest of bot.*). Allowed values:
--    'ensemble_raw' (default — raw consensus), 'calibrated' (the old accuracy center), 'wunderground'
--    (RESERVED — the resolution-source anchor, not yet wired; falls back to the ensemble_raw proxy + logs).
--
-- 2. THE ENTRY-TIME WATCHER's wider arm race. The multi-city paper-trade's arm hours {11,12,13,14} were a
--    pre-data guess (tropical ~12:30 peak). The watcher (core/sim/entry-watch, surfaced on /paper-trade)
--    finds the optimal entry hour from the graded ledger — but can only learn about hours we actually bet at.
--    Widen WSSS/OPKC to {10,11,12,13,14,15} so the day is bracketed on BOTH sides of the peak; forecast_max_hour
--    stays 12 (the lead-1 lift only helps before the floor becomes the peak). Forward ticks place the new arms;
--    a `scripts/city-sim.ts` backfill re-run (operator) fills {10,15} history from persisted intraday/snapshots.

-- 1. consensus-source ops mirror (idempotent; the code default is authoritative).
insert into public.config (key, value) values
  ('bot.consensusSource', 'ensemble_raw')
on conflict (key) do nothing;

-- 2. widen the raced arms for the two seeded tropical cities (idempotent — only the two known °C stations).
update public.city_sim_config
   set arm_hours = array[10,11,12,13,14,15]::smallint[]
 where icao in ('WSSS', 'OPKC');
