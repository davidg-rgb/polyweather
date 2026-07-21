-- 0116_retention_edge_evals_7d.sql — storage tiering, pg_cron side (STORAGE-TIERING.md).
--
-- Tightens the ONE table safe to prune purely server-side: edge_evaluations. It has NO training value (no
-- scripts/research reader; the only live reader, dash_event_detail, wants just the latest ~44 rows/event ≈ <2
-- days), so its 30-day retention was ~4× the live need — this drops it to 7 days, reclaiming ~140 MB with zero
-- live-dashboard impact and no local archive required.
--
-- DELIBERATELY NOT pruned by this cron: market_rewards + model_stats_history (their history is kept LOCAL for
-- training/testing — a blind server-side cron can't verify the local archive exists, so they are archive-gated
-- by the LOCAL scripts/ops/archive-retention.ts instead), and opening_captures (its resolution-based raw-book
-- prune is scripts/ops/prune-opening-captures.ts, gated on the local dump). See STORAGE-TIERING.md.
--
-- Only change vs 0009's ops_downsample: §7.21 edge_evaluations retention 30 days → 7 days. Everything else is
-- reproduced verbatim (create-or-replace: the latest definition wins). Rollback: re-apply 0009.

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

  -- §7.21: edge_evaluations retention 7 days (0116 — was 30d; live /events reads latest ~44 rows/event ≈ <2d,
  -- no research reader, no training value → the tightest safe server-side window).
  delete from edge_evaluations where captured_hour < now() - interval '7 days';
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
