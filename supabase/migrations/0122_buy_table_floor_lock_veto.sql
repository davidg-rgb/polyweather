-- 0122_buy_table_floor_lock_veto.sql — ARM the buy-table FLOOR-LOCK VETO (FLOOR-VETO.md §8, 2026-07-28).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY: the 0121 gap veto guards the "pick far ABOVE the floor" class; its inverse leaked through — the pick
-- being exactly the bucket the running max already sits in, bought late in the station-local day (the 07-28
-- Wellington 12°C @ 0.33: house q 0.896 that the day's high was in at 13:46 local; one +1°C METAR tick
-- 48 min later killed it). That is a bet on "the high is already in" made against a book with fresher obs.
--
-- Backtest (the same real-book hourly replay panel as 0121; pre-registered extension sweep,
-- scripts/research/floor-veto-extensions.py): the contains-floor ≥13h-local class runs
--   · full  n=92:  −33.5%/$1, city-day CI [−0.60, −0.07], day-block [−0.83, −0.11], win 22.8%
--   · test  n=48:  −49.0%/$1, city-day CI [−0.81, −0.17], day-block [−1.05, −0.24]
--   · hour-robust (≥12h −38%, ≥14h −48%); worst in laggy-METAR stations (wuhan 1/16, beijing 0/11, KL 0/5).
-- On the real fills it blocks KL 07-21 33°C (lost) and Wellington 07-28 12°C (lost) — zero real winners.
-- The OTHER swept families all failed and stay out: gap 2°C/12h tightening (increment SIGN-FLIPS
-- train +0.18 → test −0.43 — unstable), overconfidence q−ask (n too small, sign-flips), late-hour
-- blankets and ask-level cutoffs (≈0 — late/expensive entries per se are fairly priced).
--
-- WHAT: seed the one key the handler reads (parseBuyTableConfig):
--   buy_table.floor_lock_veto_min_local_hour = 13   (station-local fractional hour from which a pick whose
--                                                    bucket CONTAINS the official-rounded running max is
--                                                    skipped; 0 disables — the code default while unapplied)
--
-- APPLYING THIS MIGRATION = ARMING THE VETO (the 0115/0121 precedent). Fail-open on missing floor/tz/label;
-- single/range buckets only (tails were not in the measured class). No new tables, no cron change.
--
-- Rollback: delete from public.config where key = 'buy_table.floor_lock_veto_min_local_hour';
--           (the code default 0 then disables the veto until re-seeded).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

insert into public.config (key, value) values
  ('buy_table.floor_lock_veto_min_local_hour', '13')
on conflict (key) do nothing;
