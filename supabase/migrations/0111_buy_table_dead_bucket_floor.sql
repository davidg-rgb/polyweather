-- 0111_buy_table_dead_bucket_floor.sql — the DEAD-BUCKET FLOOR read for the BUY-TABLE lane (operator
-- directive 2026-07-19).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY: the first continuous-mode window bought helsinki 19°C (5000 sh @ 0.001) at 00:03Z while the day's
-- observed running max was ALREADY 20°C — floor(day-high) could never be 19 again; the bucket was provably
-- dead at purchase time and the market's 0.001 was the correct price ("dead on arrival … a direct loss",
-- operator). The °C daily-high is a monotone running max (the same mechanism WO-5/AMSTERDAM-SIM measured):
-- once the observed max passes a bucket's top, that bucket cannot win. The lane must never buy such a bucket
-- however cheap the ask.
--
-- WHAT: buy_table_intraday_floor(p_cities, p_dates) — one row per (city slug, target date) with the station's
-- OBSERVED intraday running max so far (intraday_max, the metar-nowcast §7.8 monotone store): maxTenthsC +
-- lastObsAt. The buy-table-tick joins this onto its candidates and skips any predicted bucket whose top the
-- running max has already cleared (dead_bucket skip; parseBucketLabel + the wuRound metarMaxToNative replica
-- decide "cleared" in native units — monotone, so a stale read can only MISS a death, never falsely kill a
-- live bucket; the gate fails toward buying by construction).
--
-- 0081 TRIPWIRE COMPLIANCE: returns ONE jsonb OBJECT envelope ({floors: [...]}), never SETOF.
-- Grants: service_role only (the convergence_capture_inputs idiom — an Edge-tick/daemon read, no browser
-- caller). No table, no cron change.
--
-- Rollback: drop function public.buy_table_intraday_floor(text[], date[]);
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.buy_table_intraday_floor(p_cities text[], p_dates date[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('floors', coalesce(jsonb_agg(jsonb_build_object(
    'city',       c.slug,
    'targetDate', im.date_local,
    'maxTenthsC', im.max_tenths_c,
    'lastObsAt',  im.last_obs_at
  )), '[]'::jsonb))
  from cities c
  join city_stations cs on cs.city_id = c.id and cs.valid_to is null
  join intraday_max im on im.icao = cs.icao and im.date_local = any(coalesce(p_dates, '{}'))
  where c.slug = any(coalesce(p_cities, '{}')) and im.max_tenths_c is not null;
$$;

revoke all on function public.buy_table_intraday_floor(text[], date[]) from public, anon, authenticated;
grant  execute on function public.buy_table_intraday_floor(text[], date[]) to service_role;
