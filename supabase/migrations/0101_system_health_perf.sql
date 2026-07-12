-- 0101_system_health_perf.sql — /system was 500 on prod: dash_system_health() needs ~16.5s uncontended
-- (measured 2026-07-12) against the callers' 8s statement_timeout, so the page could NEVER render.
-- Two costs, two fixes — the payload contract of both functions is UNCHANGED:
--
--   1. forecast_gap_matrix(p_days) ran 45 stations × 8 models × p_days as ~2,520 per-row NOT EXISTS
--      index probes (~3.8s measured). Re-stated as ONE set-based anti-join against the p_days slice of
--      forecast_snapshots (forecast_snapshots_target_lead_idx leads on target_date) — same rows out.
--      This also de-fragilizes the snapshot-forecasts tick, which calls the same function and was
--      timing out at the congested 10:15Z slot (job_runs 07-11 + 07-12).
--
--   2. dash_system_health()'s storage gauges were three EXACT count(*) seq scans — 2.4s + 3.5s + 6.8s
--      measured on the grown tables, every page load. Gauges don't need exactness: pg_class.reltuples
--      (the planner's autovacuum-maintained estimate) is instant and tracks within a fraction of a
--      percent on these hot tables. greatest(…, 0) guards the never-analyzed -1 sentinel.
--
-- Rollback: re-apply the 0020-era bodies (exact counts + NOT EXISTS matrix) — but /system will 500 again.

create or replace function public.forecast_gap_matrix(p_days integer)
returns table(icao text, model text, target_date date)
language sql
security definer
set search_path to 'public'
as $function$
  with universe as (
    select st.icao as u_icao, m.slug as u_model, d::date as u_date
    from list_active_stations() st
    cross join (select mm.slug from models mm where mm.enabled and not mm.is_ensemble) m
    cross join generate_series(current_date - (p_days - 1), current_date, interval '1 day') d
  ),
  present as (
    select distinct f.icao as p_icao, f.model as p_model, f.target_date as p_date
    from forecast_snapshots f
    where f.target_date between current_date - (p_days - 1) and current_date
  )
  select u.u_icao, u.u_model, u.u_date
  from universe u
  left join present p
    on p.p_icao = u.u_icao and p.p_model = u.u_model and p.p_date = u.u_date
  where p.p_icao is null;
$function$;

create or replace function public.dash_system_health()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'jobRuns', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'job', x.job, 'periodKey', x.period_key, 'status', x.status, 'attempt', x.attempt,
        'startedAt', x.started_at, 'durationMs', x.duration_ms, 'error', x.error, 'stats', x.stats
      ) order by x.started_at desc), '[]'::jsonb)
      from (select * from job_runs order by started_at desc limit 100) x
    ),
    'failures24h', (
      select coalesce(jsonb_agg(jsonb_build_object('job', f.job, 'failed', f.n) order by f.n desc), '[]'::jsonb)
      from (select job, count(*) as n from job_runs
            where status = 'failed' and started_at > now() - interval '24 hours'
            group by job) f
    ),
    'alertsRecent', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'kind', a.kind, 'severity', a.severity, 'title', a.title, 'sent', a.sent, 'at', a.created_at
      ) order by a.created_at desc), '[]'::jsonb)
      from (select * from alerts_log order by created_at desc limit 50) a
    ),
    'dataGaps', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'icao', g.icao, 'model', g.model, 'date', g.target_date)), '[]'::jsonb)
      from (select * from public.forecast_gap_matrix(7) limit 100) g
    ),
    'storage', (
      -- planner estimates, not exact counts — the exact scans cost 12.7s/page-load at current row counts
      select jsonb_build_object(
        'forecastRows', (select greatest(reltuples, 0)::bigint from pg_class where oid = 'public.forecast_snapshots'::regclass),
        'snapshotRows', (select greatest(reltuples, 0)::bigint from pg_class where oid = 'public.market_snapshots'::regclass),
        'probRows', (select greatest(reltuples, 0)::bigint from pg_class where oid = 'public.bucket_probabilities'::regclass))
    )
  ) into v;
  return v;
end;
$function$;
