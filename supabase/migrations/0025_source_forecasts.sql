-- 0025_source_forecasts.sql — external weather-source accuracy tracking.
--
-- WeatherAPI.com and OpenWeatherMap are tracked as EXTERNAL comparison sources,
-- deliberately ISOLATED from the trading pipeline: their daily-max forecasts land
-- here (NOT in forecast_snapshots / models), so they are scored against the same
-- WU/IEM truth without ever entering list_enabled_models, the house blend
-- (get_build_inputs), or run-calibration's model_stats. "Keep them logged
-- separate." A winner can later be promoted into the trading blend deliberately.

create table if not exists public.source_forecasts (
  icao          text not null references public.stations(icao),
  source        text not null,                                 -- 'weatherapi' | 'openweathermap' | …
  target_date   date not null,                                 -- station-local forecast day
  lead_days     smallint not null check (lead_days between 0 and 16),
  snapshot_slot text not null check (snapshot_slot in ('10Z', '22Z')),
  tmax_c        numeric(5,2) not null,                         -- forecast daily max, °C
  captured_at   timestamptz not null,
  created_at    timestamptz not null default now(),
  primary key (icao, source, target_date, lead_days, snapshot_slot)
);

create index if not exists source_forecasts_source_idx on public.source_forecasts (source, target_date);

-- RLS: mirror every other table (operator reads; service-role writes; anon nothing).
alter table public.source_forecasts enable row level security;
drop policy if exists operator_read on public.source_forecasts;
create policy operator_read on public.source_forecasts
  for select to authenticated using (public.is_operator());
grant select on public.source_forecasts to anon, authenticated;
grant all on public.source_forecasts to service_role;

-- Batch upsert of one capture's rows (raw jsonb array — postgres-js JSON-encodes
-- the RAW array under ::jsonb; never pre-stringify, see scripts/lib/pglite-param.ts).
create or replace function public.upsert_source_forecasts(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  insert into source_forecasts (icao, source, target_date, lead_days, snapshot_slot, tmax_c, captured_at)
  select r.icao, r.source, r.target_date, r.lead_days, r.snapshot_slot, r.tmax_c, r.captured_at
  from jsonb_to_recordset(p_rows) as r(
    icao text, source text, target_date date, lead_days smallint,
    snapshot_slot text, tmax_c numeric, captured_at timestamptz
  )
  on conflict (icao, source, target_date, lead_days, snapshot_slot) do update
    set tmax_c = excluded.tmax_c, captured_at = excluded.captured_at;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- source_accuracy — the UNIFIED cross-source comparison. Returns raw
-- sufficient statistics per (source, icao, lead_days) over finalized truth, so
-- the caller can roll up overall / by-lead / by-city accuracy any way. Unions the
-- deterministic Open-Meteo models (forecast_snapshots) with the external sources
-- (source_forecasts); for each (icao, source, target_date, lead) the LATEST
-- capture is scored (one forecast per cell). p_window_days null = all-time.
create or replace function public.source_accuracy(p_window_days int default null)
returns table (
  source     text,
  icao       text,
  lead_days  int,
  n          int,
  sum_abs    numeric,
  sum_err    numeric,
  sum_sq     numeric,
  hits_1c    int,
  hits_2c    int
)
language sql
security definer
set search_path = public
as $$
  with f as (
    select fs.icao, fs.model as source, fs.target_date, fs.lead_days, fs.tmax_c, fs.captured_at
    from forecast_snapshots fs
    union all
    select sf.icao, sf.source, sf.target_date, sf.lead_days, sf.tmax_c, sf.captured_at
    from source_forecasts sf
  ),
  latest as (
    select distinct on (icao, source, target_date, lead_days)
           icao, source, target_date, lead_days, tmax_c
    from f
    order by icao, source, target_date, lead_days, captured_at desc
  ),
  paired as (
    select l.source, l.icao, l.lead_days,
           (l.tmax_c - case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0
                            else o.tmax_wu_native end) as err
    from latest l
    join observations o
      on o.icao = l.icao and o.date_local = l.target_date
     and o.finalized_at is not null and o.tmax_wu_native is not null
    where p_window_days is null or o.date_local > current_date - p_window_days
  )
  select source, icao, lead_days::int,
         count(*)::int                          as n,
         sum(abs(err))                          as sum_abs,
         sum(err)                               as sum_err,
         sum(err * err)                         as sum_sq,
         sum((abs(err) <= 1.0)::int)::int       as hits_1c,
         sum((abs(err) <= 2.0)::int)::int       as hits_2c
  from paired
  group by source, icao, lead_days;
$$;
