-- 0121_buy_table_floor_veto.sql — ARM the buy-table FLOOR VETO (FLOOR-VETO.md, 2026-07-28).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY: the 07-28 live entries exposed the lane's remaining intraday blind spot. The 0111 dead-bucket gate
-- kills IMPOSSIBLE picks (running max already past the bucket top); nothing guards the merely-implausible —
-- the KL 33°C buy at 13:14 local with the METAR floor sitting at 31°C for 2+ hours (house gaussian 47%,
-- market 15%; the market had priced the thermometer, our gaussian had not — CITY-ORACLE build 3's mechanism
-- showing up inside the lane). Backtest over the graded ledger window (opening-captures real-book hourly
-- replay, 829 events / 44 cities / 22 days, selector validated 1006/1006 against the 0106 fold):
--   · vetoed class (pick low ≥3°C above floor at station-local ≥10h): mean −25.3%/$1 net (n=524),
--     test-split −35.4%, city-day-clustered CI [−0.55, −0.16], precision 75% (three of four vetoed lose);
--   · morning big-gap entries WIN (tropical pre-heat) — the 10h local cutoff deliberately spares them;
--   · current-config lane replay 07-05..07-27: 38 entries, veto blocks 2 (both losses), +$10.00 saved;
--   · of the 14 resolved live fills, it blocks exactly one (helsinki 07-23 19°C, gap 4.0 @ 11.7h, lost).
--
-- WHAT: seed the two config keys the handler reads (parseBuyTableConfig):
--   buy_table.floor_veto_gap_c          = 3   (°C the pick's LOW may sit above the observed running max;
--                                              0 disables — the code default while this migration is unapplied)
--   buy_table.floor_veto_min_local_hour = 10  (station-local fractional hour from which the veto applies)
--
-- APPLYING THIS MIGRATION = ARMING THE VETO (the 0115 precedent: guards ship dark in code, the seed arms
-- them). Fail-open by construction: a missing floor row, tz, or unparseable label skips the veto, never the
-- entry pipeline. No new tables, no cron change, no RLS surface.
--
-- Rollback: delete from public.config where key in
--             ('buy_table.floor_veto_gap_c','buy_table.floor_veto_min_local_hour');
--           (the code default gap 0 then disables the veto until re-seeded).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

insert into public.config (key, value) values
  ('buy_table.floor_veto_gap_c', '3'),
  ('buy_table.floor_veto_min_local_hour', '10')
on conflict (key) do nothing;
