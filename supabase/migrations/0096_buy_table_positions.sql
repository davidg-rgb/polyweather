-- 0096_buy_table_positions.sql — dash_trading() gains `buyTable`: the BUY-TABLE lane position ledger.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY (operator-directed 2026-07-11): the /trading console's open-order ledger enumerates OPEN live rows only
-- (status intent/placed/partial — 0082 §8). The 0095 BUY-TABLE lane enters as a TAKER FAK and HOLDS TO CLOSE:
-- a successful entry goes intent → filled inside one tick, so the position drops out of the ledger the moment
-- it exists and the console shows NOTHING for the lane's live money until resolution moves the daily-loss
-- number. That is the visibility gap this closes: every live_orders strategy='buy-table' row (ANY status),
-- with a per-position resolution outcome and the lane's running totals.
--
-- WHAT: dash_trading() is re-stated VERBATIM from 0084 §3 (every existing key byte-preserved — config /
-- preflight / openOrders / openExposureUsd / today / dryRun / recentAudit / generatedAt) PLUS one new key:
--   buyTable — jsonb OBJECT { rows: [...], totals: {...} } (never a bare array — the 0081 tripwire):
--     rows   — every live_orders row with strategy='buy-table' and mode='live' (ANY status), newest first,
--              capped at 200 (the 0095 partial index live_orders_buy_table_idx covers the scan). Each row is
--              joined BEST-EFFORT to its market identity — market_buckets on condition_id (preferring the
--              bucket whose token_yes matches the order's token) → market_events → cities — so it carries
--              city slug / target_date / bucket label. A row whose market can't be joined still renders,
--              with nulls (fail-soft: the money row is never hidden by a missing join).
--     outcome per row — from the SAME resolution source every grader reads (0076 idiom):
--              coalesce(market_events.poly_resolved_winner_idx, market_events.winning_bucket_idx).
--                'failed'   — the entry attempt failed terminally (nothing posted);
--                'unfilled' — canceled with nothing matched (a FAK that missed);
--                'open'     — something held (or still working) and the market not yet resolved — ALSO the
--                             fail-soft verdict when the join/winner can't be established (never guess);
--                'won'      — held bucket IS the winner  → resolvedPnlUsd = size_matched × $1 − all-in cost;
--                'lost'     — held bucket is NOT the winner → resolvedPnlUsd = −(all-in cost).
--              all-in cost = the order's exact BUY fill cash (Σ live_fills.fill_notional — N2) + its fees
--              (Σ fee_usd — the taker fee rides the fill row per 0084 #17), falling back to
--              avg_price × size_matched when no fill rows exist.
--     totals — { nRows, nOpen, nWon, nLost, costUsd, resolvedPnlUsd } over the enumerated rows.
--   MODE SCOPE (deliberate): mode='live' only — the 0082 addendum invariant ("every money figure in
--   dash_trading filters mode='live'; dry-run rows never count") extends to this section. Dry-run shadow
--   rows stay visible through the dryRun counts + the shadow-diff harness, exactly as before.
--
-- No table, no cron, no edge fn (cron count stays 35). Grants re-asserted identical to 0082/0084
-- (service_role + authenticated; the fn self-guards via operator_guard).
--
-- 0081 TRIPWIRE COMPLIANCE: dash_trading() stays a jsonb OBJECT envelope; buyTable itself is an OBJECT
-- ({ rows, totals }), never a top-level array. No SETOF anywhere.
--
-- Rollback: re-apply 0084 §3 (create or replace function public.dash_trading() with the 0084 body) — this
-- migration only re-states the one function; nothing else to unwind.
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
