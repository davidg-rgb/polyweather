-- 0115_buy_table_dead_bucket_guards.sql — config defaults for the buy-table DEAD-BUCKET guards.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY (operator directive 2026-07-21): the lane bought a DEAD Kuala Lumpur position — 500 sh of 33°C YES @
-- $0.01. Cross-check of the fill: at 06:04Z the market had already written 33°C off (its live book had ZERO
-- bids and only ~16,000 sh of $0.001 DUST asks), while 34°C was the ~89% near-lock (best bid 0.891). Our
-- house model still centered 33°C, and the 0114 live re-quote's executableAsk walked the dust asks → reported
-- a ~1¢ executable ask → under the cap → bought. The 0111 running-max floor gate couldn't catch it: our METAR
-- didn't observe the 34°C reading until 06:34Z, 30 min AFTER the buy. The market was simply faster (the
-- efficiency thesis). Two book-truth guards (built in the edge fn, handler.ts) stop this; this migration only
-- seeds their operator-tunable thresholds so they show as editable config rows (the code carries the same
-- fallback defaults, so the guards are live the moment the fn deploys — this migration is not load-bearing for
-- them, only for visibility/tuning).
--
-- WHAT (config only — no schema, no cron, no function):
--   1. buy_table.dead_pick_min_bid (0.02) — the DEAD-PICK guard: OUR predicted bucket must have real BID
--      support in the live book (best bid ≥ this). A no-bid or dust-bid book means the market has written the
--      bucket off; the re-quote is then just sweeping dust asks. bestBid is the liveness measure — dust asks
--      can't move it. Set to 0 to DISABLE (null bids then allowed = pre-0115 behavior).
--   2. buy_table.favorite_veto_prob (0.85) — the FAVORITE VETO (the operator's explicit rule): if ANY OTHER
--      bucket's live best bid ≥ this, the market is near-certain of a different outcome, so our pick is a
--      written-off longshot → cancel. Set to a value > 1 (e.g. 2) to DISABLE.
--
-- Both edits survive a re-apply (on conflict do nothing). No tripwire surface (config rows only).
-- Rollback: delete from public.config where key in ('buy_table.dead_pick_min_bid','buy_table.favorite_veto_prob');
--           (the code fallbacks 0.02 / 0.85 then apply until re-seeded).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

insert into public.config (key, value) values
  ('buy_table.dead_pick_min_bid', '0.02'),
  ('buy_table.favorite_veto_prob', '0.85')
on conflict (key) do nothing;
