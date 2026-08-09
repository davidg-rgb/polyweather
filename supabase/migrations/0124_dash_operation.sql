-- 0124_dash_operation.sql — `dash_operation`, the operator's single view of the live cheap-early operation.
--
-- WHY. The lane was re-pointed at the cheap-early cell on 2026-08-09 (0123 + docs/ops/CHEAP-EARLY-ENTRY.md
-- §7, operator-directed continuous operation). The operator needs one page that answers, without a shell:
-- is the lane actually armed · what has it bought · is it up or down · which cities are bleeding · how does
-- it compare to the paper control · and, on a quiet day, WHY nothing fired.
--
-- SHAPE: one jsonb OBJECT envelope (0081 tripwire — never SETOF), operator-gated (`operator_guard()`), read
-- by `authenticated` + `service_role` only, mirroring `dash_cheap_early` (0117 §4) exactly.
--
-- COST. Deliberately cheap; no write-time fold is added here because none is needed:
--   • `live_orders` is the hot input and is TINY (37 rows lifetime as of 2026-08-09). The since-date scan
--     rides `live_orders_buy_table_idx (mode, created_at) where strategy='buy-table'` — an index the lane
--     already has, so this is an index range scan over tens of rows, not a table scan.
--   • The bucket/event/city join is by `market_buckets.condition_id` (the m1 bridge) — equality on an
--     indexed column, one row per order.
--   • `config` / `trade_config` / `trade_gate_override` are single-digit-row reads.
--   • The paper-control strip reads ONE `cheap_early_panel` row (latest) — the same single-row read
--     `dash_cheap_early` already does, not a re-aggregation.
--   • The skip histogram reads ONE `job_runs` row (latest buy-table-tick). Its `stats->'skipTags'` is
--     folded AT WRITE TIME by the tick (handler `skipHistogram`), honouring the write-time-fold law. The
--     per-market skip REASONS exist only in the Edge logs, which SQL cannot read at all — pre-folding in
--     the tick is the only way this page can answer "why no buys today".
-- Per the rpc-latency law, time this as the CALLING role (`authenticated`), never as postgres:
-- execute_sql-as-postgres has no statement timeout and would false-pass a slow read.
--
-- MONEY MODEL (stated once, used everywhere below). A buy-table entry is a BUY held to resolution:
--   cost     = size_matched × coalesce(avg_price, price)   -- what actually left the wallet
--   payoff   = size_matched when our bucket won, else 0    -- $1/share on a win
--   realized = payoff − cost                               -- RESOLVED markets only
--   atRisk   = cost                                        -- markets not yet resolved
-- `size_matched` (NOT `size`) is the unit throughout: a partial fill deployed only what it matched. Rows
-- with no fill (failed / zero-fill canceled) contribute 0 to both — they cost nothing and risk nothing.
--
-- Rollback: drop function public.dash_operation(date);
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

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

  -- ONE query, ONE pass over the ledger. `ops` is the enriched entry set every block below reuses. A temp
  -- table would read more simply, but PostgreSQL forbids INSERT inside a non-volatile function and this
  -- read must stay `stable` — it is a dashboard poll, not a mutation.
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
      -- DERIVED from the same rule the tick applies (stop_after_first_success AND any fill); the tick's own
      -- copy of this flag lives only in job_runs.stats, so the page recomputes rather than guesses.
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
    'benchmark', (select j from bench), 'skipTelemetry', (select j from skips)
  )
  into v
  from cfg, tc, money, equity, bycity, byband, orders;

  return v;
end;
$$;

revoke all on function public.dash_operation(date) from public, anon, authenticated;
grant  execute on function public.dash_operation(date) to authenticated, service_role;

comment on function public.dash_operation(date) is
  'Operator read for /operation: the live cheap-early lane end-to-end (state, money, equity, ledger, '
  'per-city + per-band attribution with the <=20%/n>=8 prune flag, the paper control, and the tick''s '
  'write-time skip histogram). One jsonb envelope; operator_guard-gated.';
