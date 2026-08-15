-- 0127_cheap_early_variants.sql — the inputs + the read surface for the PRE-REGISTERED cheap-early
-- forward VARIANT sweep (docs/ops/CHEAP-EARLY-IMPROVE.md §8, registered 2026-08-15).
--
-- WHY. The 3,960-cell real-book sweep found NO lever that improves the failed live rule: every city-clustered
-- CI straddles zero. One cell of 3,960 came out positive (`survivor`: [33,36]h x [0.30,0.33] x margin 0.05 x
-- top-20 cities, +39.6% [+0.4, +124] on n=42) — which is exactly the shape a multiple-comparisons artifact
-- takes. So the six variants are pre-registered IN CODE and scored forward, side by side with the canonical
-- rule, on every cheap-early-panel tick. This migration ships the two things that sweep needs from the DB:
--
--   1. `cheap_early_city_hit_rates(p_window_days, p_min_graded)` — the top-K city filter's ONLY input: per
--      city, the recent prediction hit rate + its graded count, from `city_prediction_grades` (the same fold
--      the /cities page reads). Read-only, service-role, one grouped scan over a 28-day slice.
--   2. `dash_operation` — create-or-replace of the 0125 body with ONE key added ('variants'), so /operation
--      can show the variant sweep beside the live lane. The 0125 body is otherwise verbatim (operator_guard
--      included).
--
-- BOUNDARY (load-bearing). A variant verdict is MEASUREMENT ONLY: it is rendered on /cheap-early and
-- /operation and written NOWHERE else. The gate of record (`bot_gate_snapshot`, source='forward-cheap-early')
-- is still written from the CANONICAL config alone, by record_cheap_early_gate — there is no capital path off
-- a variant, by construction.
--
-- COST. (1) is a `city_prediction_grades` scan filtered to target_date >= current_date − p_window_days,
-- grouped by city — the table is one row per graded event, and the panel calls it once per tick (4x/day).
-- (2) adds one more `cheap_early_panel` latest-row read to a function that already does exactly that for
-- 'benchmark' — the same 200-row-capped table, ordered by its captured_at index.
--
-- Idempotent: create or replace throughout; no DDL on tables. Per the rpc-latency law, time dash_operation as
-- the CALLING role (`authenticated`), never as postgres.
--
-- Rollback: drop function public.cheap_early_city_hit_rates(integer, integer);
--           -- then re-apply 0125 to restore the un-extended dash_operation
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ── SECTION 1 · cheap_early_city_hit_rates — the top-K city filter's input ───────────────────────────
-- Per city: hitRate = hits / graded over the window, and the graded count the filter's minGraded bar reads.
-- Excludes ungraded rows (hit is null — an unseeded prediction) and grading_mismatch rows, exactly like the
-- /cities rate. Cities below p_min_graded are omitted entirely: the engine's filter is fail-closed, so an
-- omitted city is simply ineligible, never silently ranked off a 1-day sample.
create or replace function public.cheap_early_city_hit_rates(
  p_window_days integer default 28,
  p_min_graded  integer default 8
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
set statement_timeout to '20s'
as $function$
declare
  v            jsonb;
  v_days       int := greatest(coalesce(p_window_days, 28), 1);
  v_min_graded int := greatest(coalesce(p_min_graded, 8), 0);
begin
  select coalesce(jsonb_object_agg(city, jsonb_build_object('hitRate', hit_rate, 'graded', graded)), '{}'::jsonb)
    into v
    from (
      select g.city,
             count(*)                                            as graded,
             (count(*) filter (where g.hit))::numeric / count(*) as hit_rate
        from public.city_prediction_grades g
       where g.hit is not null
         and g.mismatch = false
         and g.target_date >= (current_date - v_days)
       group by g.city
      having count(*) >= v_min_graded
    ) r;
  return v;
end;
$function$;

revoke all on function public.cheap_early_city_hit_rates(integer, integer) from public, anon, authenticated;
grant  execute on function public.cheap_early_city_hit_rates(integer, integer) to service_role;

comment on function public.cheap_early_city_hit_rates(integer, integer) is
  '0127: per-city recent prediction hit rate + graded count from city_prediction_grades — the ONLY input to '
  'the cheap-early top-K city filter (the pre-registered `survivor` variant). Read-only, service-role; the '
  'Edge tick calls it once per run. Cities below p_min_graded are omitted (the filter is fail-closed).';

-- ── SECTION 2 · dash_operation — the 0125 body, verbatim, + the 'variants' key ───────────────────────
create or replace function public.dash_operation(p_since date default date '2026-08-09')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();

  with ops as (
    select
      lo.created_at,
      c.slug                                                             as city,
      me.target_date,
      mb.label,
      lo.side,
      lo.price,
      lo.avg_price,
      lo.size,
      lo.size_matched,
      lo.status,
      me.winning_bucket_idx is not null                                  as resolved,
      me.winning_bucket_idx = mb.bucket_idx                              as won,
      coalesce(lo.size_matched, 0) * coalesce(lo.avg_price, lo.price, 0) as cost,
      case
        when me.winning_bucket_idx is null then null
        else (case when me.winning_bucket_idx = mb.bucket_idx then coalesce(lo.size_matched, 0) else 0 end)
             - coalesce(lo.size_matched, 0) * coalesce(lo.avg_price, lo.price, 0)
      end                                                                as realized,
      case
        when me.winning_bucket_idx is null
        then coalesce(lo.size_matched, 0) * coalesce(lo.avg_price, lo.price, 0)
        else 0
      end                                                                as at_risk
    from public.live_orders lo
    join public.market_buckets mb on mb.condition_id = lo.market_id
    join public.market_events  me on me.id = mb.event_id
    join public.cities         c  on c.id = me.city_id
    where lo.mode = 'live'
      and lo.strategy = 'buy-table'
      and lo.purpose = 'entry'
      and lo.created_at >= p_since::timestamptz
  ),
  cfg as (
    select
      coalesce(max(value) filter (where key = 'buy_table.tick_enabled'), 'true')              as tick_enabled,
      coalesce(max(value) filter (where key = 'buy_table.ask_floor'), '0')                    as ask_floor,
      coalesce(max(value) filter (where key = 'buy_table.price_cap'), '0.15')                 as price_cap,
      coalesce(max(value) filter (where key = 'buy_table.lead_min_h'), '2')                   as lead_min_h,
      coalesce(max(value) filter (where key = 'buy_table.lead_max_h'), '12')                  as lead_max_h,
      coalesce(max(value) filter (where key = 'buy_table.max_buys_per_day'), '0')             as max_buys_per_day,
      coalesce(max(value) filter (where key = 'buy_table.stop_after_first_success'), 'false') as stop_first
    from public.config
    where key like 'buy_table.%'
  ),
  tc as (
    select mode, active_until, stake_per_buy_usd,
           coalesce(array_length(city_allowlist, 1), 0) as allowlist_size
    from public.trade_config where id = 1
  ),
  ovr as (
    select o.reason, o.expires_at, o.created_at, o.expires_at > now() as active,
           greatest(0, ceil(extract(epoch from (o.expires_at - now())) / 86400)::int) as days_left
    from public.trade_gate_override o order by o.expires_at desc, o.id desc limit 1
  ),
  money as (
    select count(*) n_orders,
           count(*) filter (where coalesce(size_matched, 0) > 0) n_filled,
           count(*) filter (where resolved) n_resolved,
           count(*) filter (where resolved and won) n_wins,
           coalesce(sum(cost), 0) staked,
           coalesce(sum(realized) filter (where resolved), 0) realized_usd,
           coalesce(sum(at_risk), 0) at_risk_usd,
           coalesce(sum(cost) filter (where resolved), 0) staked_resolved
    from ops
  ),
  equity as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'date', d, 'realizedUsd', realized_usd, 'atRiskUsd', at_risk_usd, 'n', n) order by d), '[]'::jsonb) j
    from (select created_at::date d,
                 coalesce(sum(realized) filter (where resolved), 0) realized_usd,
                 coalesce(sum(at_risk), 0) at_risk_usd,
                 count(*) n
          from ops group by 1) e
  ),
  bycity as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'city', city, 'n', n, 'nResolved', n_res, 'wins', wins,
             'winRate', case when n_res = 0 then null else wins::numeric / n_res end,
             'stakedUsd', staked, 'realizedUsd', realized_usd,
             'pruneFlag', n_res >= 8 and (wins::numeric / nullif(n_res, 0)) <= 0.20
           ) order by realized_usd), '[]'::jsonb) j
    from (select city, count(*) n, count(*) filter (where resolved) n_res,
                 count(*) filter (where resolved and won) wins,
                 coalesce(sum(cost), 0) staked,
                 coalesce(sum(realized) filter (where resolved), 0) realized_usd
          from ops group by city) y
  ),
  byband as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'band', band, 'n', n, 'nResolved', n_res, 'wins', wins,
             'winRate', case when n_res = 0 then null else wins::numeric / n_res end,
             'stakedUsd', staked, 'realizedUsd', realized_usd) order by band), '[]'::jsonb) j
    from (select case when coalesce(avg_price, price) < 0.25 then '[0.20,0.25)'
                      when coalesce(avg_price, price) < 0.30 then '[0.25,0.30)'
                      else '[0.30,0.33]' end band,
                 count(*) n, count(*) filter (where resolved) n_res,
                 count(*) filter (where resolved and won) wins,
                 coalesce(sum(cost), 0) staked,
                 coalesce(sum(realized) filter (where resolved), 0) realized_usd
          from ops where coalesce(size_matched, 0) > 0 group by band) z
  ),
  orders as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'createdAt', created_at, 'city', city, 'targetDate', target_date, 'label', label,
             'side', side, 'price', price, 'avgPrice', avg_price, 'size', size,
             'sizeMatched', size_matched, 'status', status, 'resolved', resolved, 'won', won,
             'costUsd', cost, 'realizedUsd', realized) order by created_at desc), '[]'::jsonb) j
    from ops
  ),
  bench as (
    select jsonb_build_object(
             'capturedAt', cep.captured_at,
             'gateLabel',  cep.view -> 'gate' ->> 'label',
             'gateReason', cep.view -> 'gate' ->> 'reason',
             'nMarkets',   (cep.view -> 'gate' ->> 'nMarkets')::numeric,
             'nCities',    (cep.view -> 'gate' ->> 'nCities')::numeric,
             'meanNetReturn', (cep.view -> 'gate' ->> 'meanNetReturn')::numeric,
             'paperRealizedUsd', (cep.view -> 'money' ->> 'realizedPnlUsd')::numeric,
             'paperRoi',   (cep.view -> 'money' ->> 'roi')::numeric,
             'paperWinRate', (cep.view -> 'money' ->> 'winRate')::numeric) j
    from public.cheap_early_panel cep order by cep.captured_at desc limit 1
  ),
  skips as (
    select jsonb_build_object(
             'at', jr.started_at, 'tags', coalesce(jr.stats -> 'skipTags', '{}'::jsonb),
             'skips', jr.stats -> 'skips', 'captures', jr.stats -> 'captures',
             'candidates', jr.stats -> 'candidates', 'degraded', jr.stats -> 'degraded') j
    from public.job_runs jr where jr.job = 'buy-table-tick'
    order by jr.started_at desc limit 1
  ),
  -- 0125 · the NARRATIVE log — a LIMIT 50 backwards index scan; cost does not grow with the table.
  log as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', id, 'at', at, 'kind', kind, 'title', title, 'body', body, 'meta', meta
           ) order by at desc, id desc), '[]'::jsonb) j
    from (select id, at, kind, title, body, meta
          from public.operation_log order by at desc, id desc limit 50) l
  ),
  -- 0125 · the per-day tick snapshot. `last_tags` is the day's FINAL skip histogram, not a day aggregate —
  -- summing per-tick counts across ~288 ticks would multiply every unbought market by the tick rate.
  ticks as (
    select started_at::date d,
           count(*) n_ticks,
           (array_agg(stats -> 'skipTags' order by started_at desc))[1] last_tags
    from public.job_runs
    where job = 'buy-table-tick' and started_at >= (current_date - 13)
    group by 1
  ),
  daymoney as (
    select created_at::date d,
           count(*) n_orders,
           count(*) filter (where coalesce(size_matched, 0) > 0) n_fills,
           coalesce(sum(cost), 0) staked,
           coalesce(sum(realized) filter (where resolved), 0) realized_usd
    from ops group by 1
  ),
  days as (
    select g::date d from generate_series(current_date - 13, current_date, interval '1 day') g
  ),
  -- the cumulative is a WINDOW function, so it must be materialised in its own layer: PostgreSQL
  -- forbids a window call inside an aggregate (jsonb_agg), which is why this is two CTEs, not one.
  daily_rows as (
    select d.d,
           coalesce(dm.n_orders, 0) n_orders,
           coalesce(dm.n_fills, 0) n_fills,
           coalesce(dm.staked, 0) staked,
           coalesce(dm.realized_usd, 0) realized_usd,
           sum(coalesce(dm.realized_usd, 0)) over (order by d.d) cum_realized,
           coalesce(t.n_ticks, 0) n_ticks,
           t.last_tags
    from days d
    left join daymoney dm on dm.d = d.d
    left join ticks t on t.d = d.d
  ),
  daily as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'date', d,
             'nOrders', n_orders,
             'nFills', n_fills,
             'stakedUsd', staked,
             'realizedUsd', realized_usd,
             'cumRealizedUsd', cum_realized,
             'nTicks', n_ticks,
             -- the day's LAST histogram's largest tag; null when the tick wrote none (pre-0124 fn).
             'topSkipTag', (
               select k from jsonb_each_text(coalesce(last_tags, '{}'::jsonb)) as e(k, val)
               order by val::int desc, k limit 1
             ),
             'topSkipN', (
               select val::int from jsonb_each_text(coalesce(last_tags, '{}'::jsonb)) as e(k, val)
               order by val::int desc, k limit 1
             )
           ) order by d desc), '[]'::jsonb) j
    from daily_rows
  )
  select jsonb_build_object(
    'lane', jsonb_build_object(
      'since', p_since,
      'mode', tc.mode, 'activeUntil', tc.active_until, 'stakePerBuyUsd', tc.stake_per_buy_usd,
      'allowlistSize', tc.allowlist_size,
      'tickEnabled', cfg.tick_enabled in ('true', '1'),
      'askFloor', cfg.ask_floor::numeric, 'priceCap', cfg.price_cap::numeric,
      'leadMinH', cfg.lead_min_h::numeric, 'leadMaxH', cfg.lead_max_h::numeric,
      'maxBuysPerDay', cfg.max_buys_per_day::int,
      'stopAfterFirstSuccess', cfg.stop_first in ('true', '1'),
      'buysToday', (select count(*) from ops
                     where coalesce(size_matched, 0) > 0
                       and created_at::date = (now() at time zone 'utc')::date),
      'laneHalted', cfg.stop_first in ('true', '1')
                    and exists (select 1 from ops where coalesce(size_matched, 0) > 0),
      'override', (select jsonb_build_object('active', active, 'reason', reason, 'expiresAt', expires_at,
                                             'createdAt', created_at, 'daysLeft', days_left) from ovr)
    ),
    'money', jsonb_build_object(
      'nOrders', money.n_orders, 'nFilled', money.n_filled, 'nResolved', money.n_resolved,
      'nWins', money.n_wins, 'stakedUsd', money.staked, 'realizedUsd', money.realized_usd,
      'atRiskUsd', money.at_risk_usd,
      'winRate', case when money.n_resolved = 0 then null
                      else money.n_wins::numeric / money.n_resolved end,
      'meanNetPerDollar', case when money.staked_resolved = 0 then null
                               else money.realized_usd / money.staked_resolved end
    ),
    'equity', equity.j, 'orders', orders.j, 'byCity', bycity.j, 'byBand', byband.j,
    'benchmark', (select j from bench), 'skipTelemetry', (select j from skips),
    -- 0127 · the PRE-REGISTERED cheap-early variant sweep, verbatim from the latest panel snapshot.
    -- Measurement only: a variant verdict has no capital path (the gate of record is canonical-only).
    'variants', (select cep.view -> 'variants' from public.cheap_early_panel cep
                  order by cep.captured_at desc limit 1),
    'log', log.j, 'daily', daily.j
  )
  into v
  from cfg, tc, money, equity, bycity, byband, orders, log, daily;

  return v;
end;
$$;

revoke all on function public.dash_operation(date) from public, anon, authenticated;
grant  execute on function public.dash_operation(date) to authenticated, service_role;

comment on function public.dash_operation(date) is
  'Operator read for /operation: the live cheap-early lane end-to-end (state, money, equity, ledger, '
  'per-city + per-band attribution with the <=20%/n>=8 prune flag, the paper control, the tick''s '
  'write-time skip histogram, the operation_log narrative, a read-derived 14-day digest, and the '
  'pre-registered cheap-early variant sweep). One jsonb envelope; operator_guard-gated.';
