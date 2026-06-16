-- 0037_operator_export_predictions.sql — prediction-vs-actual CSV export (data verification).
--
-- operator_export_predictions(from, to, icao?) returns one row per (station, finalized date) with the
-- recorded actual and the cross-model-MEAN forecast made +1/+2/+3 days earlier, plus the per-lead
-- error and model count. EVERYTHING IN °C: actuals are stored in the station's native unit (°F for US
-- cities), so °F is converted (forecast_snapshots.tmax_c is already °C) — the operator asked for a
-- single, always-°C verification view. p_icao null = the whole fleet.
--
-- 0034 invariant: part of the operator dashboard surface (apps/web routes.ts adminExportPredictions),
-- so it ships its own revoke/grant and joins WEB_AUTHENTICATED. operator_guard() self-gates it.

create or replace function public.operator_export_predictions(p_from date, p_to date, p_icao text)
returns table (line jsonb)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.operator_guard();
  return query
  with actual as (
    select o.icao, o.date_local, o.provenance,
      round((case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0
                  else o.tmax_wu_native end)::numeric, 1) as actual_c
    from observations o
    where o.finalized_at is not null
      and o.date_local between p_from and p_to
      and (p_icao is null or o.icao = p_icao)
  ),
  fc as (
    select fs.icao, fs.target_date,
      round(avg(fs.tmax_c) filter (where fs.lead_days = 1)::numeric, 1) as fc1,
      round(avg(fs.tmax_c) filter (where fs.lead_days = 2)::numeric, 1) as fc2,
      round(avg(fs.tmax_c) filter (where fs.lead_days = 3)::numeric, 1) as fc3,
      count(distinct fs.model) filter (where fs.lead_days = 1) as n1
    from forecast_snapshots fs
    where fs.target_date between p_from and p_to
      and fs.lead_days between 1 and 3
      and (p_icao is null or fs.icao = p_icao)
    group by fs.icao, fs.target_date
  )
  select jsonb_build_object(
    'icao', a.icao,
    'city', coalesce(c.display_name, ''),
    'date', a.date_local,
    'actualC', a.actual_c,
    'fcPlus1C', f.fc1, 'fcPlus2C', f.fc2, 'fcPlus3C', f.fc3,
    'errPlus1', case when f.fc1 is not null then round(a.actual_c - f.fc1, 1) end,
    'errPlus2', case when f.fc2 is not null then round(a.actual_c - f.fc2, 1) end,
    'errPlus3', case when f.fc3 is not null then round(a.actual_c - f.fc3, 1) end,
    'nModels', coalesce(f.n1, 0),
    'provenance', a.provenance
  ) as line
  from actual a
  left join fc f on f.icao = a.icao and f.target_date = a.date_local
  left join city_stations cs on cs.icao = a.icao and cs.valid_to is null
  left join cities c on c.id = cs.city_id
  order by a.icao, a.date_local;
end;
$$;

revoke all on function public.operator_export_predictions(date, date, text) from public, anon, authenticated;
grant execute on function public.operator_export_predictions(date, date, text) to service_role;
grant execute on function public.operator_export_predictions(date, date, text) to authenticated;
