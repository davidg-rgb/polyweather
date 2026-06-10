-- 0014_snapshot_rpcs.sql — forecast/ensemble capture surface (ARCHITECTURE.md §6.14).

-- Stations referenced by an ACTIVE city (last_seen within 7 days, §7.1) whose
-- coordinates are seeded (provisional rows can't build a forecast URL).
create or replace function public.list_active_stations()
returns table (icao text, lat numeric, lon numeric, tz text)
language sql
security definer
set search_path = public
as $$
  select distinct s.icao::text, s.lat, s.lon, s.tz
  from stations s
  join city_stations cs on cs.icao = s.icao and cs.valid_to is null
  join cities c on c.id = cs.city_id
  where c.last_seen > now() - interval '7 days'
    and s.lat is not null and s.lon is not null;
$$;

create or replace function public.list_enabled_models(p_is_ensemble boolean)
returns table (slug text, horizon_days smallint)
language sql
security definer
set search_path = public
as $$
  select m.slug, m.horizon_days from models m
  where m.enabled = true and m.is_ensemble = p_is_ensemble;
$$;

-- Batch upsert of one station-call's parsed rows (§7.5 natural key).
create or replace function public.upsert_forecast_rows(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
  select r.icao, r.model, r.target_date, r.lead_days, r.tmax_c, r.snapshot_slot, r.source, r.captured_at
  from jsonb_to_recordset(p_rows) as r(
    icao text, model text, target_date date, lead_days smallint, tmax_c numeric,
    snapshot_slot text, source text, captured_at timestamptz
  )
  on conflict (icao, model, target_date, lead_days, snapshot_slot) do update
    set tmax_c = excluded.tmax_c, captured_at = excluded.captured_at, source = excluded.source;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Expected-vs-present matrix over the last p_days of target dates: every
-- (active station × enabled deterministic model × day) lacking ANY snapshot row.
create or replace function public.forecast_gap_matrix(p_days int)
returns table (icao text, model text, target_date date)
language sql
security definer
set search_path = public
as $$
  select st.icao, m.slug, d::date
  from list_active_stations() st
  cross join (select mm.slug from models mm where mm.enabled and not mm.is_ensemble) m
  cross join generate_series(current_date - (p_days - 1), current_date, interval '1 day') d
  where not exists (
    select 1 from forecast_snapshots f
    where f.icao = st.icao and f.model = m.slug and f.target_date = d::date
  );
$$;

-- MODEL_DEGRADED accounting: consecutive all-null runs per model (§6.14).
create or replace function public.bump_model_null_streak(p_model text, p_was_null boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_streak int;
begin
  if not p_was_null then
    delete from config where key = 'modelNullRuns:' || p_model;
    return 0;
  end if;
  insert into config (key, value) values ('modelNullRuns:' || p_model, '1')
  on conflict (key) do update set value = ((config.value)::int + 1)::text
  returning (value)::int into v_streak;
  return v_streak;
end;
$$;

-- Batch upsert of per-member ensemble arrays (§7.6 natural key).
create or replace function public.upsert_ensemble_rows(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  insert into ensemble_snapshots (icao, model, target_date, lead_days, snapshot_slot, members_c, n_members, captured_at)
  select r.icao, r.model, r.target_date, r.lead_days, r.snapshot_slot, r.members_c, r.n_members, r.captured_at
  from jsonb_to_recordset(p_rows) as r(
    icao text, model text, target_date date, lead_days smallint, snapshot_slot text,
    members_c numeric[], n_members smallint, captured_at timestamptz
  )
  on conflict (icao, model, target_date, snapshot_slot) do update
    set members_c = excluded.members_c, n_members = excluded.n_members,
        lead_days = excluded.lead_days, captured_at = excluded.captured_at;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
