-- 0112_trading_open_positions.sql — dash_trading() gains `openPositions`: held positions marked to the live book.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY (operator-directed 2026-07-19): the /trading "Open positions & exposure" section showed only the
-- per-market COST map from the preflight checks — an opaque condition-id hash and a dollar figure. With the
-- continuous-buying lane holding real overnight positions, the operator's actual question is "what am I
-- holding, what did I pay, what is it worth NOW, am I up or down?" — and nothing on the console answered it.
-- The capture stream (opening_captures, 0066) already snapshots every enrolled market's full bucket book
-- (bestBid/bestAsk/mid) on the poll cadence, so the current mark exists in-house; this joins it in.
--
-- WHAT: dash_trading() is re-stated VERBATIM from 0109 §3 (every existing key byte-preserved — config /
-- preflight / openOrders / openExposureUsd / today / dryRun / buyTable / recentAudit / generatedAt) PLUS one
-- new key:
--   openPositions — jsonb OBJECT { rows: [...], totals: {...} } (never a bare array — the 0081 tripwire):
--     rows — one per HELD (market_id, token_id) live position, newest first buy first, ANY strategy (the
--            0082 addendum invariant holds: mode='live' only; dry-run never counts). A position is held when
--            net shares = Σ BUY size_matched − Σ SELL size_matched > 0 over ANY-status rows (a partial fill
--            preserved on a canceled reprice row is still held money — the 0084 §1(b) fills-not-status
--            precedent), and its market is NOT yet resolved (winner unknown per the 0076 resolution source
--            coalesce(poly_resolved_winner_idx, winning_bucket_idx) — resolved positions are the buyTable
--            ledger's won/lost rows, not "open"). Per row:
--              · identity — the 0096 best-effort market join (market_buckets on condition_id preferring the
--                token_yes match → market_events → cities): city / cityName / targetDate / label (the
--                temperature bucket bought) / bucketIdx. A joinless market still renders with nulls —
--                fail-soft: the money row is never hidden by a missing join.
--              · basis — shares (net), avgPrice (Σ BUY fill cash ÷ Σ BUY shares — the venue-truth average,
--                ex-fee), costUsd (BUY fill cash + fees, released pro-rata by sells at lifetime-average —
--                the 0084 §1(b) netting), firstBuyAt.
--              · mark — the LATEST opening_captures tick for the event with a buckets payload, its element
--                matched by tokenYes (preferred) or bucket idx: curBid / curAsk / curMid, markAt (staleness
--                is the reader's signal — captures stop at resolution), resolvesAt.
--              · verdict — valueMidUsd (shares × mid), unrealizedMidUsd (value − cost) and the conservative
--                unrealizedBidUsd (what selling into the current bid would realize vs cost). All null when
--                no mark exists (fail-soft — never a fabricated price).
--     totals — { nPositions, nMarked, costUsd, valueMidUsd, valueBidUsd, unrealizedMidUsd,
--                unrealizedBidUsd, oldestMarkAt } over the enumerated rows (value/unrealized sums cover
--                MARKED rows only; nMarked vs nPositions surfaces the gap honestly).
--   openExposureUsd (unchanged) stays the CAP-enforcement number — it additionally counts unfilled resting
--   commitments, so the two figures legitimately differ; the page states this.
--
-- COST SHAPE: bounded and index-backed — live mode='live' rows are dozens, the group collapses to a handful
-- of held tokens, and each mark is ONE oc_event_captured_idx-backed latest-tick lookup + a ~10-element jsonb
-- scan. No capture-table aggregate scan anywhere (the 0098/0100 statement-timeout law).
--
-- No table, no cron, no edge fn (cron count stays 35). Grants re-asserted identical to 0109
-- (service_role + authenticated; the fn self-guards via operator_guard).
--
-- 0081 TRIPWIRE COMPLIANCE: dash_trading() stays a jsonb OBJECT envelope; openPositions itself is an OBJECT
-- ({ rows, totals }), never a top-level array. No SETOF anywhere.
--
-- Rollback: re-apply 0109 §3 (create or replace function public.dash_trading() with the 0109 body) — this
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
    -- 0112: the HELD-position ledger marked to the live book — one row per (market, token) with net shares,
    -- the venue-truth entry basis, and the latest opening_captures bid/ask/mid mark + unrealized P&L.
    'openPositions', (
      with ord as (
        -- per-order basis over EVERY matched live row (ANY status, ANY strategy — fills-not-status, 0084 §1(b)):
        -- exact N2 fill cash + fees, avg×matched fallback when no fill rows exist (the 0096 idiom).
        select o.market_id, o.token_id, o.side, o.strategy, o.created_at,
               coalesce(o.size_matched, 0) as matched,
               case when o.side = 'BUY'
                    then coalesce(nullif(f.cash_usd, 0), o.avg_price * o.size_matched, 0)
                    else 0 end as buy_cash_usd,
               case when o.side = 'BUY' then coalesce(f.fee_usd, 0) else 0 end as buy_fee_usd
        from public.live_orders o
        left join lateral (
          select sum(f.fill_notional) as cash_usd, sum(f.fee_usd) as fee_usd
          from public.live_fills f
          where f.order_id = o.id
        ) f on true
        where o.mode = 'live' and coalesce(o.size_matched, 0) > 0
      ),
      pos as (
        -- collapse to the held (market, token) position: net shares, sells released at lifetime-average.
        select market_id, token_id,
               array_agg(distinct strategy) as strategies,
               min(created_at) filter (where side = 'BUY') as first_buy_at,
               coalesce(sum(matched) filter (where side = 'BUY'),  0) as bought,
               coalesce(sum(matched) filter (where side = 'SELL'), 0) as sold,
               coalesce(sum(buy_cash_usd), 0) as buy_cash,
               coalesce(sum(buy_fee_usd),  0) as buy_fees
        from ord
        group by market_id, token_id
        having coalesce(sum(matched) filter (where side = 'BUY'),  0)
             - coalesce(sum(matched) filter (where side = 'SELL'), 0) > 1e-9
      ),
      held as (
        select p.*,
               p.bought - p.sold as shares,
               greatest(0, (p.buy_cash + p.buy_fees) * (1 - p.sold / nullif(p.bought, 0))) as cost_usd,
               case when p.bought > 0 and p.buy_cash > 0 then p.buy_cash / p.bought end as avg_px
        from pos p
      ),
      ident as (
        -- the 0096 best-effort market join; a joinless market keeps NULLs (fail-soft — never hide the money).
        select h.*, j.event_id, j.city_slug, j.city_name, j.event_slug, j.target_date,
               j.bucket_label, j.bucket_idx, j.winner_idx
        from held h
        left join lateral (
          select e.id as event_id, c.slug as city_slug, c.display_name as city_name, e.slug as event_slug,
                 e.target_date, b.label as bucket_label, b.bucket_idx,
                 coalesce(e.poly_resolved_winner_idx, e.winning_bucket_idx)::int as winner_idx
          from public.market_buckets b
          join public.market_events e on e.id = b.event_id
          left join public.cities c on c.id = e.city_id
          where b.condition_id = h.market_id
          order by (b.token_yes = h.token_id) desc, b.bucket_idx
          limit 1
        ) j on true
        -- OPEN = the market has NO winner yet (0076 source). Resolved holdings are the buyTable won/lost
        -- rows — marking them at the last pre-resolution tick would be a fabricated live price.
        where j.winner_idx is null
      ),
      marked as (
        -- ONE latest-tick lookup per position (oc_event_captured_idx), then the bucket element by tokenYes
        -- (preferred — capture elements carry it since 0066) or bucket idx. Text-compare idx: never a cast
        -- that could throw inside the console RPC.
        select i.*, oc.captured_at as mark_at, oc.resolves_at,
               (pb.b ->> 'bestBid')::numeric as cur_bid,
               (pb.b ->> 'bestAsk')::numeric as cur_ask,
               (pb.b ->> 'mid')::numeric     as cur_mid
        from ident i
        left join lateral (
          select oc.captured_at, oc.resolves_at, oc.buckets
          from public.opening_captures oc
          where oc.event_id = i.event_id and oc.buckets is not null
          order by oc.captured_at desc
          limit 1
        ) oc on true
        left join lateral (
          select b.value as b
          from jsonb_array_elements(oc.buckets) b
          where (b.value ->> 'tokenYes') = i.token_id
             or (b.value ->> 'idx') = i.bucket_idx::text
          order by ((b.value ->> 'tokenYes') = i.token_id) desc
          limit 1
        ) pb on true
      )
      select jsonb_build_object(
        'rows', coalesce(jsonb_agg(jsonb_build_object(
          'marketId',         m.market_id,
          'tokenId',          m.token_id,
          'strategies',       to_jsonb(m.strategies),
          'city',             m.city_slug,
          'cityName',         m.city_name,
          'eventSlug',        m.event_slug,
          'targetDate',       m.target_date,
          'label',            m.bucket_label,
          'bucketIdx',        m.bucket_idx,
          'firstBuyAt',       m.first_buy_at,
          'shares',           round(m.shares, 4),
          'avgPrice',         case when m.avg_px is null then null else round(m.avg_px, 6) end,
          'costUsd',          round(m.cost_usd, 6),
          'curBid',           m.cur_bid,
          'curAsk',           m.cur_ask,
          'curMid',           m.cur_mid,
          'markAt',           m.mark_at,
          'resolvesAt',       m.resolves_at,
          'valueMidUsd',      case when m.cur_mid is null then null else round(m.shares * m.cur_mid, 6) end,
          'unrealizedMidUsd', case when m.cur_mid is null then null else round(m.shares * m.cur_mid - m.cost_usd, 6) end,
          'unrealizedBidUsd', case when m.cur_bid is null then null else round(m.shares * m.cur_bid - m.cost_usd, 6) end
        ) order by m.first_buy_at desc nulls last), '[]'::jsonb),
        'totals', jsonb_build_object(
          'nPositions',       count(*),
          'nMarked',          count(*) filter (where m.cur_mid is not null),
          'costUsd',          coalesce(round(sum(m.cost_usd), 6), 0),
          'valueMidUsd',      coalesce(round(sum(m.shares * m.cur_mid), 6), 0),
          'valueBidUsd',      coalesce(round(sum(m.shares * m.cur_bid), 6), 0),
          'unrealizedMidUsd', coalesce(round(sum(m.shares * m.cur_mid - m.cost_usd) filter (where m.cur_mid is not null), 6), 0),
          'unrealizedBidUsd', coalesce(round(sum(m.shares * m.cur_bid - m.cost_usd) filter (where m.cur_bid is not null), 6), 0),
          'oldestMarkAt',     min(m.mark_at)
        )
      )
      from marked m
    ),
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
        -- 0109: the operator price config the tick trades by — the global cap (buy_table.price_cap,
        -- 0.15 fallback mirroring the handler default) + the per-city MAX override map ({} = none).
        'priceConfig', jsonb_build_object(
          'globalMax', coalesce((select value::numeric from public.config where key = 'buy_table.price_cap'), 0.15),
          'cityCaps',  coalesce((select value::jsonb from public.config where key = 'buy_table.city_price_caps'), '{}'::jsonb)
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
