-- 0035_dashboard_station_observations.sql — per-station daily-Tmax inspector for /city.
--
-- Adds dash_station_observations, the dashboard's "verify the temperature collected per
-- date" view. The /city page already surfaces a divergence log (only dates where the
-- cross-checks disagreed); this is the full picture: every daily Tmax actually collected
-- for the city's CURRENT station (city_stations.valid_to is null), so the operator can
-- eyeball the §6.22 backfill and the live fetch-actuals stream.
--
-- Returns ONE jsonb object:
--   { icao, unit,
--     window:  { from, to, limit }                       -- the date window actually applied
--     summary: { n, firstDate, lastDate, wu, iem, flagged, finalized }   -- FULL history, unwindowed
--     rows:    [ { date, tmaxNative, unit, nObs, provenance, metarNative, iemF, era5C, flags, finalized } ] }
-- The summary spans all of history regardless of the window, so "612 dates, 2024-01-21 →
-- 2026-06-15" stays visible while the row table is range-filtered. Defaults: the last 90
-- days up to the latest collected date; p_limit is clamped to [1, 400] to bound the payload.
--
-- 0034 invariant: this is part of the operator dashboard surface (apps/web loaders.ts →
-- getStationObservations), so it ships its own revoke/grant — the idiom every post-0034
-- RPC must repeat — and is added to migrations.test.ts WEB_AUTHENTICATED. operator_guard()
-- self-gates it to the allow-listed operator on top of the `authenticated` grant.

create or replace function public.dash_station_observations(
  p_slug  text,
  p_from  date default null,
  p_to    date default null,
  p_limit int  default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_icao text;
  v_unit text;
  v_to   date;
  v_from date;
  v_lim  int := least(greatest(coalesce(p_limit, 120), 1), 400);
  v      jsonb;
begin
  perform public.operator_guard();

  -- The station actuals are collected for today (the current city↔station mapping).
  select cs.icao, c.unit
    into v_icao, v_unit
  from cities c
  join city_stations cs on cs.city_id = c.id and cs.valid_to is null
  where c.slug = p_slug
  limit 1;

  if v_icao is null then
    return null;  -- unknown city, or no current station mapping
  end if;

  -- Window defaults: the last 90 days up to the latest collected date.
  v_to   := coalesce(p_to, (select max(date_local) from observations where icao = v_icao), current_date);
  v_from := coalesce(p_from, v_to - 90);

  select jsonb_build_object(
    'icao', v_icao,
    'unit', v_unit,
    'window', jsonb_build_object('from', v_from, 'to', v_to, 'limit', v_lim),
    'summary', (
      select jsonb_build_object(
        'n', count(*),
        'firstDate', min(date_local),
        'lastDate', max(date_local),
        'wu', count(*) filter (where provenance = 'wu'),
        'iem', count(*) filter (where provenance = 'iem_fallback'),
        'flagged', count(*) filter (where divergence_flags is not null and array_length(divergence_flags, 1) > 0),
        'finalized', count(*) filter (where finalized_at is not null)
      )
      from observations where icao = v_icao
    ),
    'rows', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'date', o.date_local,
          'tmaxNative', o.tmax_wu_native,
          'unit', o.unit,
          'nObs', o.n_obs,
          'provenance', o.provenance,
          'metarNative', o.tmax_metar_native,
          'iemF', o.tmax_iem_f,
          'era5C', o.tmax_era5_c,
          'flags', coalesce(o.divergence_flags, array[]::text[]),
          'finalized', (o.finalized_at is not null)
        ) order by o.date_local desc
      ), '[]'::jsonb)
      from (
        select *
        from observations
        where icao = v_icao and date_local between v_from and v_to
        order by date_local desc
        limit v_lim
      ) o
    )
  ) into v;

  return v;
end;
$$;

-- 0034 contract: closed to public/anon/authenticated by default; service_role (Edge
-- Functions) always, plus the operator dashboard's `authenticated` session.
revoke all on function public.dash_station_observations(text, date, date, int) from public, anon, authenticated;
grant execute on function public.dash_station_observations(text, date, date, int) to service_role;
grant execute on function public.dash_station_observations(text, date, date, int) to authenticated;
