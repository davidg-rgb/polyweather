-- 0098_buy_table_live_cycles.sql — LIVE-CYCLE observed price ranges for the /trading buy-table panel.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY (operator directive 2026-07-12): the 0097 price-range editor asks the operator to pick a per-city
-- [min, max] entry gate, but shows nothing about what the lane's gate price has ACTUALLY done — the operator
-- wants, per city, one column per LIVE date cycle with the logged min and max over that cycle's entire live
-- period (e.g. Houston 07-13 lo 0.11 / hi 0.34, 07-14 lo 0.16 / hi 0.40) so ranges are set against observed
-- reality, not guessed.
--
-- WHAT: dash_trading() re-stated VERBATIM from the 0097 body PLUS one addition inside `buyTable`:
--   liveCycles = [{ city, targetDate, minAsk, maxAsk, nTicks, firstAt, lastAt }] — one row per
--   (cities.slug, target_date) cycle that is CURRENTLY LIVE (its market_events row unresolved AND its latest
--   capture's resolves_at still in the future), aggregated over EVERY opening_captures tick of that cycle:
--     · per tick, the price is THE LANE'S OWN GATE PRICE — the predicted bucket (argmax houseProb among
--       identity-complete buckets, the exact selectBuyTableCandidates pick), its execAsk falling back to
--       bestAsk, kept only when 0 < ask ≤ 1 (the handler's usable-ask gate);
--     · unseeded ticks (no houseProb) and ticks whose pick has no usable ask contribute NOTHING — the lane
--       could not have bought on them either;
--     · jsonb_typeof guards everywhere — a hand-mangled bucket row scores null, never raises.
--   Every other key byte-preserved. Read-only; the tick handler is untouched (no behavior change).
--
-- PERF: the scan is driven from market_events (target_date ≥ current_date − 2, unresolved) — a handful of
-- rows — then per event through the oc_event_captured_idx (event_id, captured_at) index; a live cycle's
-- captures span ≤ ~3 days, so the jsonb work stays bounded (~45 cities × ~3 cycles).
--
-- 0081 TRIPWIRE COMPLIANCE: dash_trading() stays an OBJECT; liveCycles is a jsonb ARRAY VALUE inside the
-- buyTable OBJECT (same standing as rows), '[]' when no cycle is live. No SETOF anywhere.
-- No table, no cron, no edge-fn change (cron count stays 35). Idempotent-safe (create-or-replace only).
--
-- Rollback: re-apply 0097 (create or replace function public.dash_trading() with the 0097 body).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.dash_trading()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();

  select jsonb_build_object(
    'config',    (select to_jsonb(t) from public.trade_config t where t.id = 1),
    'preflight', public.trade_live_preflight(),
    'openOrders', (
      select coalesce(jsonb_agg(to_jsonb(o) order by o.created_at desc), '[]'::jsonb)
      from public.live_orders o
      where o.mode = 'live' and o.status in ('intent', 'placed', 'partial')
    ),
    -- 0084 #7: the SHARED exposure definition (resting commitment + filled-held cost net of sold).
    'openExposureUsd', (public.trade_open_exposure()->>'total')::numeric,
    'today', (
      -- today's LIVE cash flow from fills (informational: buys deploy capital, sells return it, fees cost),
      -- all on N2 exact notionals. lossUsd is NOT derived from this cashflow — it is THE shared N1
      -- realized-at-sell-time definition (trade_today_realized_loss), identical to preflight §5 by construction.
      select jsonb_build_object(
        'buyUsd',  coalesce(sum(f.fill_notional) filter (where o.side = 'BUY'),  0),
        'sellUsd', coalesce(sum(f.fill_notional) filter (where o.side = 'SELL'), 0),
        'feeUsd',  coalesce(sum(f.fee_usd), 0),
        'netUsd',  coalesce(sum(f.fill_notional) filter (where o.side = 'SELL'), 0)
                 - coalesce(sum(f.fill_notional) filter (where o.side = 'BUY'),  0)
                 - coalesce(sum(f.fee_usd), 0),
        'lossUsd', public.trade_today_realized_loss(),
        'lossWindowStart', date_trunc('day', now()),
        'nFills',  count(f.id)
      )
      from public.live_fills f
      join public.live_orders o on o.id = f.order_id
      where o.mode = 'live' and f.filled_at >= date_trunc('day', now())
    ),
    'dryRun', (
      -- cheap shadow-rail counts only (the shadow-diff harness reads the rows themselves).
      select jsonb_build_object(
        'openOrders', count(*) filter (where status in ('intent', 'placed', 'partial')),
        'total',      count(*)
      )
      from public.live_orders where mode = 'dry-run'
    ),
    -- 0096: the BUY-TABLE lane position ledger — EVERY live strategy='buy-table' row (ANY status; a filled
    -- taker FAK leaves openOrders instantly), joined best-effort to its market + graded against the SAME
    -- resolution source the graders read (coalesce(poly_resolved_winner_idx, winning_bucket_idx) — 0076).
    'buyTable', (
      with pos as (
        select o.id, o.market_id, o.token_id, o.trade_date, o.status, o.reason,
               o.price, o.size, o.size_matched, o.avg_price, o.created_at,
               j.city_slug, j.city_name, j.event_slug, j.target_date, j.bucket_label,
               j.bucket_idx, j.winner_idx, j.token_match,
               coalesce(f.cost_usd, 0) as fill_cost_usd,
               coalesce(f.fee_usd, 0)  as fee_usd
        from public.live_orders o
        -- best-effort market identity: prefer the bucket whose YES token is the one the order holds; a
        -- condition_id with no bucket row yields NULLs (the row still renders — fail-soft by design).
        left join lateral (
          select c.slug as city_slug, c.display_name as city_name, e.slug as event_slug,
                 e.target_date, b.label as bucket_label, b.bucket_idx,
                 coalesce(e.poly_resolved_winner_idx, e.winning_bucket_idx)::int as winner_idx,
                 (b.token_yes = o.token_id) as token_match
          from public.market_buckets b
          join public.market_events e on e.id = b.event_id
          left join public.cities c on c.id = e.city_id
          where b.condition_id = o.market_id
          order by (b.token_yes = o.token_id) desc, b.bucket_idx
          limit 1
        ) j on true
        left join lateral (
          select sum(f.fill_notional) as cost_usd, sum(f.fee_usd) as fee_usd
          from public.live_fills f
          where f.order_id = o.id
        ) f on true
        where o.mode = 'live' and o.strategy = 'buy-table'
        order by o.created_at desc, o.id desc
        limit 200
      ),
      graded as (
        select p.*,
               -- all-in cost of what was matched: exact N2 fill cash + fees, avg×matched fallback.
               (case when coalesce(p.size_matched, 0) > 0
                     then coalesce(nullif(p.fill_cost_usd, 0), p.avg_price * p.size_matched, 0) + p.fee_usd
                     else 0 end) as cost_all_usd,
               case
                 when p.status = 'failed' then 'failed'
                 when coalesce(p.size_matched, 0) <= 0 then
                   case when p.status = 'canceled' then 'unfilled' else 'open' end
                 -- fail-soft: no winner yet, no join, or a token mismatch (the join is unreliable) → open.
                 when p.winner_idx is null or p.token_match is distinct from true then 'open'
                 when p.bucket_idx = p.winner_idx then 'won'
                 else 'lost'
               end as outcome
        from pos p
      ),
      final as (
        select g.*,
               case
                 when g.outcome = 'won'  then g.size_matched - g.cost_all_usd  -- winner redeems $1/share
                 when g.outcome = 'lost' then -g.cost_all_usd                  -- expired worthless
               end as resolved_pnl_usd
        from graded g
      )
      select jsonb_build_object(
        'rows', coalesce(jsonb_agg(jsonb_build_object(
          'id',             g.id,
          'createdAt',      g.created_at,
          'status',         g.status,
          'reason',         g.reason,
          'marketId',       g.market_id,
          'tokenId',        g.token_id,
          'tradeDate',      g.trade_date,
          'city',           g.city_slug,
          'cityName',       g.city_name,
          'eventSlug',      g.event_slug,
          'targetDate',     g.target_date,
          'label',          g.bucket_label,
          'bucketIdx',      g.bucket_idx,
          'winnerIdx',      g.winner_idx,
          'price',          g.price,
          'size',           g.size,
          'sizeMatched',    g.size_matched,
          'avgPrice',       g.avg_price,
          'costUsd',        round(g.cost_all_usd, 6),
          'feeUsd',         g.fee_usd,
          'outcome',        g.outcome,
          'resolvedPnlUsd', case when g.resolved_pnl_usd is null then null
                                 else round(g.resolved_pnl_usd, 6) end
        ) order by g.created_at desc, g.id desc), '[]'::jsonb),
        'totals', jsonb_build_object(
          'nRows',          count(*),
          'nOpen',          count(*) filter (where g.outcome = 'open'),
          'nWon',           count(*) filter (where g.outcome = 'won'),
          'nLost',          count(*) filter (where g.outcome = 'lost'),
          'costUsd',        coalesce(round(sum(g.cost_all_usd), 6), 0),
          'resolvedPnlUsd', coalesce(round(sum(g.resolved_pnl_usd), 6), 0)
        ),
        -- 0097: the operator price-range config the tick trades by — the global cap (buy_table.price_cap,
        -- 0.15 fallback mirroring the handler default) + the per-city [min, max] override map ({} = none).
        'priceConfig', jsonb_build_object(
          'globalMax',  coalesce((select value::numeric from public.config where key = 'buy_table.price_cap'), 0.15),
          'cityRanges', coalesce((select value::jsonb from public.config where key = 'buy_table.city_price_ranges'), '{}'::jsonb)
        ),
        -- 0098: the LIVE-CYCLE observed price ranges — for every currently-live market cycle, the min/max the
        -- lane's gate price has logged over the cycle's ENTIRE live period: per opening_captures tick, the
        -- predicted bucket = argmax houseProb among identity-complete buckets (the exact
        -- selectBuyTableCandidates pick), its price = execAsk falling back to bestAsk, kept only when
        -- 0 < ask ≤ 1. Unseeded ticks (no houseProb) contribute nothing — the lane could not have bought on
        -- them either. One row per (slug, target_date) — a same-cycle relist folds in.
        'liveCycles', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'city',       lc.slug,
            'targetDate', lc.target_date,
            'minAsk',     lc.min_ask,
            'maxAsk',     lc.max_ask,
            'nTicks',     lc.n_ticks,
            'firstAt',    lc.first_at,
            'lastAt',     lc.last_at
          ) order by lc.slug, lc.target_date), '[]'::jsonb)
          from (
            select c.slug, e.target_date,
                   min(agg.min_ask)  as min_ask,
                   max(agg.max_ask)  as max_ask,
                   sum(agg.n_ticks)  as n_ticks,
                   min(agg.first_at) as first_at,
                   max(agg.last_at)  as last_at
            from public.market_events e
            join public.cities c on c.id = e.city_id
            cross join lateral (
              select min(pb.ask)         as min_ask,
                     max(pb.ask)         as max_ask,
                     count(*)            as n_ticks,
                     min(oc.captured_at) as first_at,
                     max(oc.captured_at) as last_at,
                     max(oc.resolves_at) as max_resolves_at
              from public.opening_captures oc
              cross join lateral (
                -- the tick's pick: argmax houseProb among identity-complete buckets; ITS ask or nothing
                -- (never the next-best bucket's — a pick without a usable ask is the handler's no_ask skip).
                select case when jsonb_typeof(b.value->'execAsk') = 'number' then (b.value->>'execAsk')::numeric
                            when jsonb_typeof(b.value->'bestAsk') = 'number' then (b.value->>'bestAsk')::numeric
                       end as ask
                from jsonb_array_elements(oc.buckets) b
                where jsonb_typeof(b.value->'houseProb') = 'number'
                  and coalesce(b.value->>'conditionId', '') <> ''
                  and coalesce(b.value->>'tokenYes', '')    <> ''
                order by (b.value->>'houseProb')::numeric desc
                limit 1
              ) pb
              where oc.event_id = e.id
                and jsonb_typeof(oc.buckets) = 'array'
                and pb.ask is not null and pb.ask > 0 and pb.ask <= 1
            ) agg
            where e.target_date >= current_date - 2                                  -- bound the event scan
              and coalesce(e.poly_resolved_winner_idx, e.winning_bucket_idx) is null -- unresolved…
              and agg.n_ticks > 0                                                    -- …with logged gate prices…
              and agg.max_resolves_at > now()                                        -- …and still trading = LIVE
            group by c.slug, e.target_date
          ) lc
        )
      )
      from final g
    ),
    'recentAudit', (
      select coalesce(jsonb_agg(to_jsonb(a) order by a.changed_at desc), '[]'::jsonb)
      from (
        select * from public.trade_config_audit order by changed_at desc limit 20
      ) a
    ),
    'generatedAt', now()
  ) into v;

  return v;
end;
$$;

revoke all on function public.dash_trading() from public, anon, authenticated;
grant  execute on function public.dash_trading() to service_role, authenticated;
