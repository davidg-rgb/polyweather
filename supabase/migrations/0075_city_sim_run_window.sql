-- 0075_city_sim_run_window.sql
-- Bound the multi-city paper-trade (migration 0070) to a fixed run window: `active_until` caps how many
-- calendar days a city keeps placing NEW bets once (re)activated. Null = unbounded (legacy default).
-- Grading is untouched — city_sim_grade_inputs() has no dependency on city_sim_config, so bets placed
-- before the cutoff still settle normally after it passes.

alter table public.city_sim_config
  add column if not exists active_until date;

create or replace function public.city_sim_active_configs()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'cityId', cfg.city_id, 'slug', cfg.slug, 'icao', cfg.icao, 'tz', cfg.tz,
    'armHours', cfg.arm_hours, 'forecastMaxHour', cfg.forecast_max_hour,
    'stakeUsd', cfg.stake_usd, 'unit', c.unit, 'displayName', c.display_name
  ) order by cfg.slug), '[]'::jsonb)
  from public.city_sim_config cfg
  join public.cities c on c.id = cfg.city_id
  where cfg.active
    and (cfg.active_until is null or current_date <= cfg.active_until);
$$;

-- Reactivate both cities (found active=false at some point after the 2026-06-30 arm-hour widening — the
-- 2026-07-01 10:00 UTC tick's job_runs row shows cities:0, confirming the rail sat inactive that day) and
-- bound the fresh run to a total of 30 calendar days (today counts as day 1).
update public.city_sim_config
set active = true,
    active_until = current_date + 29,
    updated_at = now()
where slug in ('singapore', 'karachi');
