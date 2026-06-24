-- 0058_reward_and_whale_dashboards.sql — read-only dashboard RPCs for the /rewards + /whaletracker pages.
--
-- Two operator-gated, security-definer reads over the LIVE analytics feeds (both already accumulating on prod):
--   • dash_market_rewards — the REC-8/9 Phase A market_rewards time-series (0057): funded-weather reward POOL
--     vs in-band competing maker CAPITAL, per capture + a latest headline + the top-pool markets. Surfaces the
--     deferred "Phase A re-run" thin-book trend LIVE (is competing capital thickening = window closing, or
--     staying thin = window open). REWARD-FARMING-HANDOFF §10–§11.
--   • dash_whale_tracker — the past-N-days ≥$min whale_trades (0055): individual ≥$100k bets with the profile
--     link (proxy_wallet), bet link, what (title + side/outcome) + value (notional), plus a daily-notional
--     series. A NEW function (NOT a dash_whale_watch re-signature — the 0054 "function is not unique" overload
--     trap) because it returns proxy_wallet (which builds the profile link) and dash_whale_watch omits it.
--
-- BOTH return a jsonb OBJECT, never a top-level jsonb array (the 0044 trap: the prod supabasePort misreads a
-- bare array as a RETURNS TABLE row set and silently zeroes it — PGlite tests pass either way). Read-only
-- analytics; the live trading rail stays DORMANT (no packages/trading, no orders). No table/cron change — the
-- pg_cron registration count stays 18. RLS note: market_rewards is RLS-on with NO read policy, so it is ONLY
-- readable through this security-definer RPC (which bypasses RLS); whale_trades grants operator select but is
-- read here through the RPC for one consistent operator_guard + jsonb-object contract.

-- === 1. dash_market_rewards — funded-weather reward pool vs in-band competing capital (market_rewards, 0057) ===
create or replace function public.dash_market_rewards(p_days int default 7, p_top int default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_days   int := greatest(coalesce(p_days, 7), 1);
  v_top    int := greatest(coalesce(p_top, 20), 1);
  v_latest timestamptz;
begin
  perform public.operator_guard();

  select max(captured_at) into v_latest from public.market_rewards;

  select jsonb_build_object(
    -- per-capture time series (one row per captured_at): pool vs in-band competing maker capital, ascending.
    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
        'capturedAt',     s.captured_at,
        'nMarkets',       s.n_markets,
        'totalPoolUsd',   s.total_pool_usd,
        'totalInBandUsd', s.total_in_band_usd
      ) order by s.captured_at)
      from (
        select captured_at,
               count(*)                                                   as n_markets,
               sum(daily_pool_usd)                                        as total_pool_usd,
               sum(coalesce(bid_depth_usd, 0) + coalesce(ask_depth_usd, 0)) as total_in_band_usd
        from public.market_rewards
        where captured_at >= now() - make_interval(days => v_days)
        group by captured_at
      ) s
    ), '[]'::jsonb),

    -- latest-capture headline (null capturedAt / 0 markets when the table is empty).
    'latest', (
      select jsonb_build_object(
        'capturedAt',     v_latest,
        'nMarkets',       count(*),
        'totalPoolUsd',   sum(daily_pool_usd),
        'totalInBandUsd', sum(coalesce(bid_depth_usd, 0) + coalesce(ask_depth_usd, 0))
      )
      from public.market_rewards
      where captured_at = v_latest
    ),

    -- top markets by daily pool, latest capture only.
    'topMarkets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'slug',           t.slug,
        'dailyPoolUsd',   t.daily_pool_usd,
        'mid',            t.mid,
        'bestBid',        t.best_bid,
        'bestAsk',        t.best_ask,
        'bidDepthUsd',    t.bid_depth_usd,
        'askDepthUsd',    t.ask_depth_usd,
        'maxSpreadCents', t.max_spread_cents
      ) order by t.daily_pool_usd desc nulls last)
      from (
        select slug, daily_pool_usd, mid, best_bid, best_ask, bid_depth_usd, ask_depth_usd, max_spread_cents
        from public.market_rewards
        where captured_at = v_latest
        order by daily_pool_usd desc nulls last
        limit v_top
      ) t
    ), '[]'::jsonb)
  ) into v;

  return v;
end;
$$;

-- === 2. dash_whale_tracker — past-N-days ≥$min whale trades + daily-notional series (whale_trades, 0055) =======
-- NEW function (proxy_wallet → profile link); param window + min-USD so the planned /whaletracker filter
-- expansion is purely additive. Rows capped at 500 (newest first); meta.count/totalUsd are the UNCAPPED totals.
create or replace function public.dash_whale_tracker(p_days int default 10, p_min_usd numeric default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_days  int       := greatest(coalesce(p_days, 10), 1);
  v_min   numeric   := greatest(coalesce(p_min_usd, 0), 0);
  v_since timestamptz := now() - make_interval(days => v_days);
begin
  perform public.operator_guard();

  select jsonb_build_object(
    -- individual bets, newest first, capped (rich row: profile link, bet link, what + value).
    'bets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tradedAt',    b.traded_at,
        'proxyWallet', b.proxy_wallet,
        'trader',      coalesce(nullif(b.trader_name, ''), b.proxy_wallet),
        'side',        b.side,
        'outcome',     b.outcome,
        'title',       b.title,
        'notionalUsd', b.notional_usd,
        'price',       b.price,
        'sizeShares',  b.size_shares,
        'link',        b.link,
        'txHash',      b.transaction_hash,
        'eventSlug',   b.event_slug
      ) order by b.traded_at desc)
      from (
        select * from public.whale_trades
        where traded_at >= v_since and notional_usd >= v_min
        order by traded_at desc
        limit 500
      ) b
    ), '[]'::jsonb),

    -- per-UTC-day notional + count, ascending (the bar-chart series).
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date',     d.day,
        'count',    d.n,
        'totalUsd', d.total_usd
      ) order by d.day)
      from (
        select (traded_at at time zone 'utc')::date as day,
               count(*)          as n,
               sum(notional_usd) as total_usd
        from public.whale_trades
        where traded_at >= v_since and notional_usd >= v_min
        group by (traded_at at time zone 'utc')::date
      ) d
    ), '[]'::jsonb),

    -- window meta (uncapped totals — independent of the 500-row bets cap).
    'meta', jsonb_build_object(
      'days',     v_days,
      'minUsd',   v_min,
      'count',    (select count(*)               from public.whale_trades where traded_at >= v_since and notional_usd >= v_min),
      'totalUsd', coalesce((select sum(notional_usd) from public.whale_trades where traded_at >= v_since and notional_usd >= v_min), 0)
    )
  ) into v;

  return v;
end;
$$;

-- === 3. grants (post-0034 contract: operator-readable dashboard surface) ======================================
revoke all on function public.dash_market_rewards(int, int)      from public, anon, authenticated;
grant  execute on function public.dash_market_rewards(int, int)      to authenticated, service_role;
revoke all on function public.dash_whale_tracker(int, numeric)   from public, anon, authenticated;
grant  execute on function public.dash_whale_tracker(int, numeric)   to authenticated, service_role;
