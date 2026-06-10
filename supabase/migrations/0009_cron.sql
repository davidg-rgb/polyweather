-- 0009_cron.sql — retention/downsample function + pg_cron registrations (§7.22).
--
-- Secrets: every job command reads CRON_SECRET (and the project URL) from
-- Supabase Vault AT RUN TIME — `select command from cron.job` never contains a
-- literal secret (W11). Vault rows 'cron_secret' and 'project_url' are seeded
-- manually per RUNBOOK before the schedules can fire.

-- ---------------------------------------------------------------------------
-- ops_downsample — enforces EVERY retention rule (§7.5, §7.8, §7.11, §7.12,
-- §7.21, plus the 90-day job_runs/alerts_log prune). Scheduled daily 03:00 UTC.
-- Returns per-rule deleted counts for observability.
-- ---------------------------------------------------------------------------
create or replace function public.ops_downsample()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_forecast bigint;
  n_ms_hourly bigint;
  n_ms_quarter bigint;
  n_ms_daily bigint;
  n_probs bigint;
  n_edge bigint;
  n_intraday bigint;
  n_job_runs bigint;
  n_alerts bigint;
begin
  -- §7.5: forecast rows older than 90 days keep only leads 0–2 at slot 10Z
  -- (the calibration-relevant history, ~85% reduction).
  delete from forecast_snapshots
  where captured_at < now() - interval '90 days'
    and not (lead_days between 0 and 2 and snapshot_slot = '10Z');
  get diagnostics n_forecast = row_count;

  -- §7.11 tier 1: rows > 7 days downsampled to hourly (keep earliest per hour).
  delete from market_snapshots
  where id in (
    select id from (
      select id,
             row_number() over (
               partition by bucket_id, date_trunc('hour', captured_at at time zone 'utc')
               order by captured_at, id
             ) as rn
      from market_snapshots
      where captured_at < now() - interval '7 days'
    ) ranked
    where rn > 1
  );
  get diagnostics n_ms_hourly = row_count;

  -- §7.11 tier 2: rows > 30 days downsampled to 4/day (6-hour windows).
  delete from market_snapshots
  where id in (
    select id from (
      select id,
             row_number() over (
               partition by bucket_id,
                            ((captured_at at time zone 'utc'))::date,
                            floor(extract(hour from captured_at at time zone 'utc') / 6)
               order by captured_at, id
             ) as rn
      from market_snapshots
      where captured_at < now() - interval '30 days'
    ) ranked
    where rn > 1
  );
  get diagnostics n_ms_quarter = row_count;

  -- §7.11 tier 3: rows > 180 days downsampled to 1/day.
  delete from market_snapshots
  where id in (
    select id from (
      select id,
             row_number() over (
               partition by bucket_id, ((captured_at at time zone 'utc'))::date
               order by captured_at, id
             ) as rn
      from market_snapshots
      where captured_at < now() - interval '180 days'
    ) ranked
    where rn > 1
  );
  get diagnostics n_ms_daily = row_count;

  -- §7.12: 30 days after an event resolves, delete its distribution rows EXCEPT
  -- scored rows, the final row per source, and nowcast extrema (first + last
  -- nowcast row per source — the time-series extremes of the constraint path).
  delete from bucket_probabilities bp
  using market_events me
  where bp.event_id = me.id
    and me.resolved_at is not null
    and me.resolved_at < now() - interval '30 days'
    and bp.scored_for_leads = '{}'
    and bp.id not in (
      select distinct on (event_id, source) id
      from bucket_probabilities
      order by event_id, source, made_at desc, id desc
    )
    and bp.id not in (
      select id from (
        select id,
               row_number() over (partition by event_id, source order by made_at asc,  id asc)  as rn_first,
               row_number() over (partition by event_id, source order by made_at desc, id desc) as rn_last
        from bucket_probabilities
        where nowcast
      ) nc
      where nc.rn_first = 1 or nc.rn_last = 1
    );
  get diagnostics n_probs = row_count;

  -- §7.21: edge_evaluations retention 30 days.
  delete from edge_evaluations where captured_hour < now() - interval '30 days';
  get diagnostics n_edge = row_count;

  -- §7.8: intraday_max pruned > 14 days.
  delete from intraday_max where date_local < (current_date - 14);
  get diagnostics n_intraday = row_count;

  -- §7.17/§7.18: job_runs and alerts_log retention 90 days.
  delete from job_runs where created_at < now() - interval '90 days';
  get diagnostics n_job_runs = row_count;
  delete from alerts_log where created_at < now() - interval '90 days';
  get diagnostics n_alerts = row_count;

  return jsonb_build_object(
    'forecast_snapshots', n_forecast,
    'market_snapshots_hourly', n_ms_hourly,
    'market_snapshots_4perday', n_ms_quarter,
    'market_snapshots_daily', n_ms_daily,
    'bucket_probabilities', n_probs,
    'edge_evaluations', n_edge,
    'intraday_max', n_intraday,
    'job_runs', n_job_runs,
    'alerts_log', n_alerts
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- pg_cron registrations (§7.22). cron.schedule(name, …) upserts by job name, so
-- re-applying is idempotent. Fire-and-forget against runJob's 202 (ADR-02/12):
-- timeout 4500ms only ever sees the fast 202/409/401 paths.
-- execute-bet is deliberately NOT registered — web-proxy on demand only (ADR-10).
-- ---------------------------------------------------------------------------
do $$
declare
  fn record;
  edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping registrations (test environment without a stub?)';
    return;
  end if;

  for fn in
    select * from (values
      ('discover-markets',    '10 2,4,5,11,17 * * *'),
      ('snapshot-forecasts',  '15 10,22 * * *'),
      ('snapshot-ensembles',  '35 10,22 * * *'),
      ('build-distributions', '50 10,22 * * *'),
      ('poll-markets',        '*/5 * * * *'),
      ('metar-nowcast',       '*/15 * * * *'),
      ('fetch-actuals',       '20 * * * *'),
      ('run-calibration',     '30 11 * * *'),
      ('grade-bets',          '0 6 * * *'),
      ('daily-digest',        '0 7 * * *'),
      ('health-monitor',      '*/30 * * * *')
    ) as jobs(name, schedule)
  loop
    edge_command := format(
      $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/%s',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$,
      fn.name
    );
    perform cron.schedule(fn.name, fn.schedule, edge_command);
  end loop;

  -- SQL-only retention job (§7.22 last row).
  perform cron.schedule('snapshot-downsample', '0 3 * * *', 'select public.ops_downsample()');
end;
$$;
