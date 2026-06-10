-- 0015_truth_rpcs.sql — fetch-actuals + metar-nowcast surface (ARCHITECTURE.md §6.15).

-- Stations of active cities with the truth-pipeline context: city unit drives
-- WU units e/m, wu_country_code builds the {ICAO}:9:{CC} location code.
create or replace function public.list_truth_stations()
returns table (icao text, tz text, unit text, wu_cc text, us_state text, city_slug text)
language sql
security definer
set search_path = public
as $$
  select distinct s.icao::text, s.tz, c.unit, cs.wu_country_code::text, s.us_state::text, c.slug
  from stations s
  join city_stations cs on cs.icao = s.icao and cs.valid_to is null
  join cities c on c.id = cs.city_id
  where c.last_seen > now() - interval '7 days';
$$;

-- Dates in [p_from, p_to] that already carry a FINALIZED observation.
create or replace function public.finalized_dates(p_icao text, p_from date, p_to date)
returns table (date_local date)
language sql
security definer
set search_path = public
as $$
  select o.date_local from observations o
  where o.icao = p_icao and o.date_local between p_from and p_to
    and o.finalized_at is not null;
$$;

create or replace function public.upsert_observation(
  p_icao text, p_date date, p_tmax smallint, p_unit text, p_n_obs smallint
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provenance, provisional)
  values (p_icao, p_date, p_tmax, p_unit, p_n_obs, 'wu', true)
  on conflict (icao, date_local) do update
    set tmax_wu_native = excluded.tmax_wu_native, n_obs = excluded.n_obs,
        unit = excluded.unit, provenance = 'wu';
$$;

create or replace function public.finalize_observation(
  p_icao text, p_date date,
  p_metar_tenths numeric, p_metar_native smallint, p_iem_f numeric, p_era5_c numeric,
  p_divergence text[]
)
returns void
language sql
security definer
set search_path = public
as $$
  update observations
     set provisional = false, finalized_at = now(),
         tmax_metar_tenths_c = p_metar_tenths, tmax_metar_native = p_metar_native,
         tmax_iem_f = p_iem_f, tmax_era5_c = p_era5_c, divergence_flags = p_divergence
   where icao = p_icao and date_local = p_date;
$$;

create or replace function public.set_config_value(p_key text, p_value text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into config (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value;
$$;

-- Ungraded events for a station's city on a date (grading trigger, §6.15).
create or replace function public.events_for_grading(p_icao text, p_date date)
returns table (event_id uuid)
language sql
security definer
set search_path = public
as $$
  select me.id
  from market_events me
  join city_stations cs on cs.city_id = me.city_id and cs.valid_to is null
  where cs.icao = p_icao and me.target_date = p_date and me.winning_bucket_idx is null;
$$;

-- Monotone running max (§7.8): returns true only when the max ADVANCED.
create or replace function public.upsert_intraday(
  p_icao text, p_date date, p_max_tenths numeric, p_max_native smallint, p_n_obs smallint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advanced boolean := false;
begin
  insert into intraday_max (icao, date_local, max_tenths_c, max_native, n_obs, last_obs_at)
  values (p_icao, p_date, p_max_tenths, p_max_native, p_n_obs, now())
  on conflict (icao, date_local) do update
    set max_tenths_c = excluded.max_tenths_c, max_native = excluded.max_native,
        n_obs = excluded.n_obs, last_obs_at = now()
    where intraday_max.max_tenths_c is null or excluded.max_tenths_c > intraday_max.max_tenths_c
  returning true into v_advanced;
  return coalesce(v_advanced, false);
end;
$$;

-- Stations with an OPEN event targeting the given station-local date — the
-- nowcast set; includes whether a target-day distribution exists to rebuild.
create or replace function public.nowcast_targets()
returns table (icao text, tz text, unit text, city_slug text, event_id uuid, target_date date, has_distribution boolean)
language sql
security definer
set search_path = public
as $$
  select s.icao::text, s.tz, c.unit, c.slug, me.id, me.target_date,
         exists (select 1 from bucket_probabilities bp where bp.event_id = me.id) as has_distribution
  from market_events me
  join cities c on c.id = me.city_id
  join city_stations cs on cs.city_id = c.id and cs.valid_to is null
  join stations s on s.icao = cs.icao
  where me.closed = false and me.winning_bucket_idx is null;
$$;
