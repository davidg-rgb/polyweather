-- 0038_dashboard_station_predictions.sql — per-station prediction-vs-actual + forecast-skill panel for /city.
--
-- Adds dash_station_predictions, the /city "did our forecast match what actually happened" view — the
-- on-page complement to 0037's operator_export_predictions CSV. For the city's CURRENT station
-- (city_stations.valid_to is null), returns, per FINALIZED actual date: the recorded actual and the
-- cross-model-MEAN forecast made +1/+2/+3 days earlier, the per-lead signed error (actual − forecast),
-- and the lead-1 model count — plus a FULL-history forecast-skill summary (MAE + mean bias + n per
-- lead). EVERYTHING IN °C: actuals are stored in the station's native unit (°F for US cities) so °F is
-- converted; forecast_snapshots.tmax_c is already °C — one always-°C verification view, matching 0037.
-- Only finalized actuals count (provisional truth can flip and would corrupt the skill numbers).
--
-- Returns ONE jsonb object (mirrors 0035 dash_station_observations' window/summary/rows shape):
--   { icao, unit ('C'),
--     window:  { from, to, limit }                                  -- the date window actually applied
--     summary: { n, withForecast, firstDate, lastDate,              -- FULL finalized history, unwindowed
--                lead1: { n, mae, bias }, lead2: {...}, lead3: {...} }
--     rows:    [ { date, actualC, fcPlus1C, fcPlus2C, fcPlus3C, errPlus1, errPlus2, errPlus3, nModels, provenance } ] }
-- The summary spans all finalized history regardless of the window; rows are range-filtered and the
-- limit is clamped to [1, 400]. Defaults: last 90 days up to the latest finalized date. Per-lead skill
-- is computed from the SAME rounded errors the rows show, so the panel and CSV reconcile exactly.
--
-- 0034 invariant: this is part of the operator dashboard surface (apps/web loaders.ts →
-- getStationPredictions), so it ships its own revoke/grant — the idiom every post-0034 RPC must repeat
-- — and is added to migrations.test.ts WEB_AUTHENTICATED. operator_guard() self-gates it on top of the
-- `authenticated` grant.

create or replace function public.dash_station_predictions(
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
  v_to   date;
  v_from date;
  v_lim  int := least(greatest(coalesce(p_limit, 120), 1), 400);
  v      jsonb;
begin
  perform public.operator_guard();

  -- The forecasts/actuals are keyed to today's current city↔station mapping.
  select cs.icao into v_icao
  from cities c
  join city_stations cs on cs.city_id = c.id and cs.valid_to is null
  where c.slug = p_slug
  limit 1;

  if v_icao is null then
    return null;  -- unknown city, or no current station mapping
  end if;

  -- Window defaults: the last 90 days up to the latest FINALIZED actual.
  v_to   := coalesce(p_to, (select max(date_local) from observations
                            where icao = v_icao and finalized_at is not null), current_date);
  v_from := coalesce(p_from, v_to - 90);

  with actual_all as (
    select o.date_local, o.provenance,
      round((case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0
                  else o.tmax_wu_native end)::numeric, 1) as actual_c
    from observations o
    where o.icao = v_icao and o.finalized_at is not null
  ),
  fc_all as (
    select fs.target_date,
      round(avg(fs.tmax_c) filter (where fs.lead_days = 1)::numeric, 1) as fc1,
      round(avg(fs.tmax_c) filter (where fs.lead_days = 2)::numeric, 1) as fc2,
      round(avg(fs.tmax_c) filter (where fs.lead_days = 3)::numeric, 1) as fc3,
      count(distinct fs.model) filter (where fs.lead_days = 1) as n1
    from forecast_snapshots fs
    where fs.icao = v_icao and fs.lead_days between 1 and 3
    group by fs.target_date
  ),
  paired as (
    select a.date_local, a.provenance, a.actual_c,
      f.fc1, f.fc2, f.fc3, coalesce(f.n1, 0) as n_models,
      case when f.fc1 is not null then round(a.actual_c - f.fc1, 1) end as err1,
      case when f.fc2 is not null then round(a.actual_c - f.fc2, 1) end as err2,
      case when f.fc3 is not null then round(a.actual_c - f.fc3, 1) end as err3
    from actual_all a
    left join fc_all f on f.target_date = a.date_local
  )
  select jsonb_build_object(
    'icao', v_icao,
    'unit', 'C',
    'window', jsonb_build_object('from', v_from, 'to', v_to, 'limit', v_lim),
    'summary', (
      select jsonb_build_object(
        'n', count(*),
        'withForecast', count(*) filter (where err1 is not null or err2 is not null or err3 is not null),
        'firstDate', min(date_local),
        'lastDate', max(date_local),
        'lead1', jsonb_build_object('n', count(err1), 'mae', round(avg(abs(err1)), 2), 'bias', round(avg(err1), 2)),
        'lead2', jsonb_build_object('n', count(err2), 'mae', round(avg(abs(err2)), 2), 'bias', round(avg(err2), 2)),
        'lead3', jsonb_build_object('n', count(err3), 'mae', round(avg(abs(err3)), 2), 'bias', round(avg(err3), 2))
      )
      from paired
    ),
    'rows', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'date', p.date_local,
          'actualC', p.actual_c,
          'fcPlus1C', p.fc1, 'fcPlus2C', p.fc2, 'fcPlus3C', p.fc3,
          'errPlus1', p.err1, 'errPlus2', p.err2, 'errPlus3', p.err3,
          'nModels', p.n_models,
          'provenance', p.provenance
        ) order by p.date_local desc
      ), '[]'::jsonb)
      from (
        select *
        from paired
        where date_local between v_from and v_to
        order by date_local desc
        limit v_lim
      ) p
    )
  ) into v;

  return v;
end;
$$;

-- 0034 contract: closed to public/anon/authenticated by default; service_role (Edge Functions)
-- always, plus the operator dashboard's `authenticated` session.
revoke all on function public.dash_station_predictions(text, date, date, int) from public, anon, authenticated;
grant execute on function public.dash_station_predictions(text, date, date, int) to service_role;
grant execute on function public.dash_station_predictions(text, date, date, int) to authenticated;
