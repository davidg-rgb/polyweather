-- 0042_amsterdam_edge_ci.sql — surface the per-arm graded (won, ask) rows so the dashboard can show
-- each arm's hit/edge/EV with a 95% CONFIDENCE INTERVAL (AMSTERDAM-EV-MODEL.md Deliverable 1).
--
-- The 0039/0040 dash_amsterdam_sim already returns per-arm point estimates (hitRate, avgAsk, pnl). The
-- analytics question — "is any arm's edge (hit − ask) clearly off zero yet, or is the market efficient?"
-- — can't be answered from a point estimate at the low n the live sim starts with; it needs an interval.
-- The three CIs (Wilson for the hit-rate proportion, mean ± 1.96·SE for the paired hit−ask gap, a seeded
-- percentile bootstrap for the heavy-tailed EV/$1) live ONCE in @weather-edge/core (sim/stats.ts —
-- armEdgeStats), exactly so the loader and the scripts/amsterdam-best-buy backtest compute them
-- identically. To feed that one helper, this migration only adds a `betsByArm` payload to the read RPC:
-- per arm, the graded bets' (won, ask). Everything else in dash_amsterdam_sim is unchanged (0040 body).
--
-- Read-only, additive, idempotent: create-or-replace of one already-authenticated RPC, no DDL, no new
-- surface, no signature change. The loader degrades to point estimates if `betsByArm` is absent (the page
-- can deploy ahead of this migration).

create or replace function public.dash_amsterdam_sim()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();

  with b as (
    select * from public.amsterdam_paper_bets
  ),
  equity as (
    select arm_hour, target_date, status, won, pnl_usd, ask, label, predicted_native_c, actual_native_c,
      sum(coalesce(pnl_usd, 0)) over (partition by arm_hour order by target_date
                                      rows between unbounded preceding and current row) as cum,
      row_number() over (partition by arm_hour, (status <> 'pending') order by target_date) as graded_rank
    from b
  ),
  arm_stats as (
    select arm_hour,
      count(*) as n_bets,
      count(*) filter (where status <> 'pending') as n_graded,
      count(*) filter (where status = 'pending')  as n_pending,
      count(*) filter (where status = 'won')       as n_won,
      sum(stake_usd) filter (where status <> 'pending') as staked_graded,
      coalesce(sum(pnl_usd), 0) as pnl,
      avg(ask) as avg_ask,
      avg((won)::int) filter (where status <> 'pending') as hit_rate,
      coalesce(sum(pnl_usd) filter (
        where status <> 'pending'
          and target_date <= (
            select min(t14) from (
              select target_date as t14 from b b2
              where b2.arm_hour = b.arm_hour and b2.status <> 'pending'
              order by target_date offset 13 limit 1
            ) q
          )
      ), coalesce(sum(pnl_usd) filter (where status <> 'pending'), 0)) as pnl_at_compare
    from b
    group by arm_hour
  ),
  latest_day as (
    select max(target_date) as d from b
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'config', jsonb_build_object('primaryHour', 15, 'armHours', jsonb_build_array(13, 14, 15, 16),
                                 'compareDays', 14, 'stakeUsd', 10),
    'coverage', (
      select jsonb_build_object(
        'firstDate', min(target_date), 'lastDate', max(target_date),
        'nDays', count(distinct target_date),
        'nGradedDays', count(distinct target_date) filter (where status <> 'pending'),
        'nPending', count(*) filter (where status = 'pending')
      ) from b
    ),
    'arms', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'hour', arm_hour,
        'nBets', n_bets, 'nGraded', n_graded, 'nPending', n_pending, 'nWon', n_won,
        'staked', staked_graded, 'pnl', pnl,
        'roi', case when coalesce(staked_graded, 0) > 0 then pnl / staked_graded end,
        'hitRate', hit_rate, 'avgAsk', avg_ask, 'pnlAtCompare', pnl_at_compare
      ) order by arm_hour), '[]'::jsonb) from arm_stats
    ),
    'leader', (
      select jsonb_build_object('hour', arm_hour, 'pnl', pnl, 'nGraded', n_graded)
      from arm_stats where n_graded > 0 order by pnl desc, arm_hour limit 1
    ),
    'equityByArm', (
      select coalesce(jsonb_object_agg(arm_hour::text, series), '{}'::jsonb) from (
        select arm_hour, jsonb_agg(jsonb_build_object(
          'date', target_date, 'pnl', pnl_usd, 'cum', cum, 'status', status
        ) order by target_date) as series
        from equity group by arm_hour
      ) s
    ),
    -- NEW (0042): the per-arm graded (won, ask) rows — the input to core/sim/stats armEdgeStats, which
    -- computes the hit/edge/EV CIs in the loader. Graded bets only (a pending bet has no won outcome yet).
    'betsByArm', (
      select coalesce(jsonb_object_agg(arm_hour::text, series), '{}'::jsonb) from (
        select arm_hour, jsonb_agg(jsonb_build_object('won', won, 'ask', ask) order by target_date) as series
        from b where status <> 'pending'
        group by arm_hour
      ) s
    ),
    'betLog', (
      select coalesce(jsonb_agg(row order by d desc, h desc), '[]'::jsonb) from (
        select target_date as d, arm_hour as h, jsonb_build_object(
          'date', target_date, 'hour', arm_hour, 'predictedC', predicted_native_c, 'label', label,
          'ask', ask, 'runMaxC', running_max_c, 'forecastC', forecast_c, 'status', status, 'won', won,
          'pnl', pnl_usd, 'actualC', actual_native_c
        ) as row
        from b order by target_date desc, arm_hour desc limit 120
      ) lg
    ),
    'latest', (
      select jsonb_build_object(
        'date', (select d from latest_day),
        'byHour', coalesce(jsonb_object_agg(arm_hour::text, jsonb_build_object(
          'predictedC', predicted_native_c, 'label', label, 'ask', ask, 'status', status,
          'won', won, 'pnl', pnl_usd, 'actualC', actual_native_c, 'runMaxC', running_max_c,
          'forecastC', forecast_c
        )), '{}'::jsonb)
      )
      from b where target_date = (select d from latest_day)
    )
  ) into v;

  return v;
end;
$$;

-- create-or-replace preserves grants; re-assert the post-0034 contract (operator-authenticated read).
revoke all on function public.dash_amsterdam_sim() from public, anon, authenticated;
grant  execute on function public.dash_amsterdam_sim() to service_role;
grant  execute on function public.dash_amsterdam_sim() to authenticated;
