-- 0022_dashboard_rpcs.sql — the §6.21 loader surface: one SECURITY DEFINER
-- read RPC per page, guarded by is_operator() (the dashboard reads everything;
-- anon sees nothing — ADR-13). One round trip per page load.

-- / (today overview)
create or replace function public.dash_today_overview(p_mode text, p_champion text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'bankroll', (select coalesce(sum(amount_usd), 0) from bankroll_ledger where mode = p_mode),
    'openRecs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'betId', bt.id, 'eventSlug', me.slug, 'city', c.display_name, 'label', b.label,
        'q', bt.our_q, 'execAsk', bt.exec_ask, 'edge', bt.edge, 'minEdge', bt.min_edge,
        'kellyRaw', bt.kelly_raw, 'kellyFrac', bt.kelly_frac, 'cappedFrac', bt.capped_frac,
        'stake', bt.rec_stake_usd, 'shares', bt.rec_shares, 'mode', bt.mode,
        'recommendedAt', bt.recommended_at, 'audit', bt.audit
      ) order by bt.recommended_at desc), '[]'::jsonb)
      from bets bt
      join market_buckets b on b.id = bt.bucket_id
      join market_events me on me.id = bt.event_id
      join cities c on c.id = me.city_id
      where bt.status = 'recommended'
    ),
    'openBets', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'eventId', bt.event_id, 'citySlug', c.slug, 'cluster', c.region,
        'stakeUsd', case when bt.status = 'filled' then coalesce(bt.executed_size_usd, bt.rec_stake_usd)
                         else bt.rec_stake_usd end,
        'targetDate', me.target_date)), '[]'::jsonb)
      from bets bt
      join market_events me on me.id = bt.event_id
      join cities c on c.id = me.city_id
      where bt.status in ('recommended', 'filled')
    ),
    'pnlSeries', (
      select coalesce(jsonb_agg(jsonb_build_object('at', x.created_at, 'balance', x.balance_usd) order by x.created_at), '[]'::jsonb)
      from (select created_at, balance_usd from bankroll_balance where mode = p_mode
            order by created_at desc, id desc limit 200) x
    ),
    'breakerStates', (
      select coalesce(jsonb_agg(jsonb_build_object('key', key, 'value', value) order by key), '[]'::jsonb)
      from config where key like 'halt:%'
    ),
    'jobHealth', (
      select coalesce(jsonb_agg(jsonb_build_object('job', j.job, 'lastOk', j.last_ok, 'running', j.running_started)), '[]'::jsonb)
      from public.job_freshness() j
    )
  ) into v;
  return v;
end;
$$;

-- /events/[slug]
create or replace function public.dash_event_detail(p_slug text, p_champion text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'event', jsonb_build_object(
      'id', me.id, 'slug', me.slug, 'targetDate', me.target_date, 'unit', me.unit,
      'city', c.display_name, 'citySlug', c.slug, 'tz', c.tz,
      'acceptingOrders', me.accepting_orders, 'volume24h', me.volume24h,
      'winningBucketIdx', me.winning_bucket_idx, 'ladderOk', me.ladder_ok, 'closed', me.closed
    ),
    'ladder', (
      select jsonb_agg(jsonb_build_object(
        'idx', b.bucket_idx, 'label', b.label, 'low', b.low_native, 'high', b.high_native,
        'feeRate', b.fee_rate, 'minOrderSize', b.min_order_size,
        'lastSnapshot', (
          select jsonb_build_object('bestBid', ms.best_bid, 'bestAsk', ms.best_ask, 'mid', ms.mid,
                                    'spread', ms.spread, 'bookTop3', ms.book_top3, 'capturedAt', ms.captured_at)
          from market_snapshots ms where ms.bucket_id = b.id
          order by ms.captured_at desc limit 1
        )
      ) order by b.bucket_idx)
      from market_buckets b where b.event_id = me.id
    ),
    'houseDist', (
      select jsonb_build_object('probs', bp.probs, 'mu', bp.mu_native, 'sigma', bp.sigma_native,
                                'nowcast', bp.nowcast, 'madeAt', bp.made_at, 'lead', bp.lead_days)
      from bucket_probabilities bp
      where bp.event_id = me.id and bp.source = p_champion
      order by bp.made_at desc limit 1
    ),
    'consensusDist', (
      select jsonb_build_object('probs', bp.probs, 'madeAt', bp.made_at)
      from bucket_probabilities bp
      where bp.event_id = me.id and bp.source = 'market_consensus'
      order by bp.made_at desc limit 1
    ),
    'snapshotsSpark', (
      select coalesce(jsonb_agg(jsonb_build_object('at', x.captured_at, 'mid', x.mid) order by x.captured_at), '[]'::jsonb)
      from (select ms.captured_at, ms.mid from market_snapshots ms
            join market_buckets b on b.id = ms.bucket_id
            where b.event_id = me.id and ms.mid is not null
            order by ms.captured_at desc limit 300) x
    ),
    'bets', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'betId', bt.id, 'label', b.label, 'status', bt.status, 'mode', bt.mode,
        'q', bt.our_q, 'execAsk', bt.exec_ask, 'edge', bt.edge, 'minEdge', bt.min_edge,
        'stake', bt.rec_stake_usd, 'shares', bt.rec_shares,
        'executedPrice', bt.executed_price, 'executedShares', bt.executed_shares,
        'pnl', bt.pnl_usd, 'audit', bt.audit, 'recommendedAt', bt.recommended_at
      ) order by bt.recommended_at desc), '[]'::jsonb)
      from bets bt join market_buckets b on b.id = bt.bucket_id
      where bt.event_id = me.id
    ),
    'edgeEvaluations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'bucketIdx', ee.bucket_idx, 'hour', ee.captured_hour, 'q', ee.q, 'execAsk', ee.exec_ask,
        'edge', ee.edge, 'minEdge', ee.min_edge, 'pass', ee.pass, 'reasons', ee.reasons
      ) order by ee.captured_hour desc, ee.bucket_idx), '[]'::jsonb)
      from (select * from edge_evaluations e where e.event_id = me.id
            order by e.captured_hour desc limit 44) ee
    ),
    'runningMax', (
      select jsonb_build_object('maxNative', im.max_native, 'maxTenthsC', im.max_tenths_c,
                                'nObs', im.n_obs, 'lastObsAt', im.last_obs_at)
      from intraday_max im
      join city_stations cs on cs.city_id = me.city_id and cs.valid_to is null
      where im.icao = cs.icao and im.date_local = me.target_date
    )
  ) into v
  from market_events me
  join cities c on c.id = me.city_id
  where me.slug = p_slug;
  return v;
end;
$$;

-- /city/[slug]
create or replace function public.dash_city_detail(p_slug text, p_champion text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'city', jsonb_build_object('slug', c.slug, 'name', c.display_name, 'unit', c.unit,
                               'tz', c.tz, 'region', c.region, 'bettingEnabled', c.betting_enabled),
    'openEventToday', (
      select jsonb_build_object('slug', me.slug, 'targetDate', me.target_date)
      from market_events me
      where me.city_id = c.id and not me.closed
      order by me.target_date limit 1
    ),
    'stationHistory', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', cs.id, 'icao', cs.icao, 'verified', cs.verified,
        'validFrom', cs.valid_from, 'validTo', cs.valid_to) order by cs.valid_from desc), '[]'::jsonb)
      from city_stations cs where cs.city_id = c.id
    ),
    'calibrationHeatmap', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'model', s.model, 'lead', s.lead_days, 'slot', s.snapshot_slot,
        'bias', s.bias_c, 'sigma', s.residual_sigma_c, 'n', s.n_residuals, 'weight', s.weight)), '[]'::jsonb)
      from model_stats s
      join city_stations cs on cs.city_id = c.id and cs.valid_to is null
      where s.icao = cs.icao
    ),
    'brierTrend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'source', cs2.source, 'lead', cs2.lead_days, 'window', cs2.window_tag,
        'brier', cs2.brier, 'brierMarket', cs2.brier_market, 'ece', cs2.ece,
        'sharpness', cs2.sharpness, 'n', cs2.n_events)), '[]'::jsonb)
      from calibration_scores cs2 where cs2.city_id = c.id
    ),
    'betHistory', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'betId', bt.id, 'eventSlug', me.slug, 'label', b.label, 'status', bt.status,
        'stake', bt.rec_stake_usd, 'pnl', bt.pnl_usd, 'recommendedAt', bt.recommended_at
      ) order by bt.recommended_at desc), '[]'::jsonb)
      from bets bt
      join market_events me on me.id = bt.event_id and me.city_id = c.id
      join market_buckets b on b.id = bt.bucket_id
    ),
    'divergenceLog', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', o.date_local, 'flags', o.divergence_flags,
        'wu', o.tmax_wu_native, 'metar', o.tmax_metar_native, 'iemF', o.tmax_iem_f
      ) order by o.date_local desc), '[]'::jsonb)
      from (select * from observations ob
            join city_stations cs3 on cs3.city_id = c.id and cs3.valid_to is null and ob.icao = cs3.icao
            where ob.divergence_flags is not null and array_length(ob.divergence_flags, 1) > 0
            order by ob.date_local desc limit 30) o
    )
  ) into v
  from cities c where c.slug = p_slug;
  return v;
end;
$$;

-- /calibration
create or replace function public.dash_calibration(p_champion text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'scores', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'city', c.slug, 'cityId', cs.city_id, 'source', cs.source, 'lead', cs.lead_days,
        'window', cs.window_tag, 'brier', cs.brier, 'brierMarket', cs.brier_market,
        'bootstrapP', cs.bootstrap_p, 'ece', cs.ece, 'sharpness', cs.sharpness,
        'reliability', cs.reliability, 'n', cs.n_events)), '[]'::jsonb)
      from calibration_scores cs
      left join cities c on c.id = cs.city_id
    ),
    'champion', (select value from config where key = 'championSource')
  ) into v;
  return v;
end;
$$;

-- /bets
create or replace function public.dash_bets_ledger(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'bets', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'betId', bt.id, 'eventSlug', me.slug, 'city', c.display_name, 'label', b.label,
        'status', bt.status, 'mode', bt.mode, 'q', bt.our_q, 'edge', bt.edge,
        'execAsk', bt.exec_ask, 'executedPrice', bt.executed_price,
        'shares', coalesce(bt.executed_shares, bt.rec_shares),
        'stake', coalesce(bt.executed_size_usd, bt.rec_stake_usd),
        'fee', bt.executed_fee, 'pnl', bt.pnl_usd,
        'recommendedAt', bt.recommended_at, 'executedAt', bt.executed_at
      ) order by bt.recommended_at desc), '[]'::jsonb)
      from (select * from bets order by recommended_at desc limit 500) bt
      join market_buckets b on b.id = bt.bucket_id
      join market_events me on me.id = bt.event_id
      join cities c on c.id = me.city_id
      where bt.mode = p_mode
    ),
    'totals', (
      select jsonb_build_object(
        'n', count(*), 'wins', count(*) filter (where status = 'resolved_win'),
        'losses', count(*) filter (where status = 'resolved_lose'),
        'pnl', coalesce(sum(pnl_usd), 0),
        'staked', coalesce(sum(executed_size_usd) filter (where executed_size_usd is not null), 0))
      from bets where mode = p_mode
    ),
    'equityCurve', (
      select coalesce(jsonb_agg(jsonb_build_object('at', x.created_at, 'balance', x.balance_usd) order by x.created_at), '[]'::jsonb)
      from (select created_at, balance_usd from bankroll_balance where mode = p_mode
            order by created_at desc, id desc limit 500) x
    ),
    'hitRateByEdgeDecile', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'decile', decile, 'n', n, 'hitRate', hit_rate, 'avgEdge', avg_edge, 'avgQ', avg_q, 'pnl', pnl_sum)
        order by decile), '[]'::jsonb)
      from edge_decile_stats where mode = p_mode
    )
  ) into v;
  return v;
end;
$$;

-- /system
create or replace function public.dash_system_health()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
      -- forecast_gap_matrix returns the MISSING (icao, model, target_date) cells
      select coalesce(jsonb_agg(jsonb_build_object(
        'icao', g.icao, 'model', g.model, 'date', g.target_date)), '[]'::jsonb)
      from (select * from public.forecast_gap_matrix(7) limit 100) g
    ),
    'storage', (
      select jsonb_build_object(
        'forecastRows', (select count(*) from forecast_snapshots),
        'snapshotRows', (select count(*) from market_snapshots),
        'probRows', (select count(*) from bucket_probabilities))
    )
  ) into v;
  return v;
end;
$$;

-- /admin
create or replace function public.dash_admin_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'config', (
      select coalesce(jsonb_agg(jsonb_build_object('key', key, 'value',
        case when key = 'wuApiKey' then '••• redacted (§11.5)' else value end) order by key), '[]'::jsonb)
      from config where key not like 'halt:%' and key not like '_budget:%'
    ),
    'halts', (
      select coalesce(jsonb_agg(jsonb_build_object('key', key, 'value', value) order by key), '[]'::jsonb)
      from config where key like 'halt:%'
    ),
    'audit', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'key', a.key, 'old', a.old_value, 'new', a.new_value, 'actor', a.actor, 'at', a.created_at
      ) order by a.created_at desc), '[]'::jsonb)
      from (select * from config_audit order by created_at desc limit 50) a
    ),
    'unverifiedStations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', cs.id, 'city', c.slug, 'icao', cs.icao, 'validFrom', cs.valid_from)), '[]'::jsonb)
      from city_stations cs
      join cities c on c.id = cs.city_id
      where cs.valid_to is null and not cs.verified
    )
  ) into v;
  return v;
end;
$$;
