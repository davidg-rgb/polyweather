-- 0097_buy_table_price_ranges.sql — per-city PURCHASE-PRICE RANGES for the BUY-TABLE live lane.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY (operator directive 2026-07-11, explicit): the 0095 lane gates entries on a single GLOBAL cap
-- (ask ≤ buy_table.price_cap, $0.15). The operator wants the purchase price as a PER-CITY [min, max] RANGE
-- input from /trading: the global default stays [0, buy_table.price_cap] (current behavior unchanged), and a
-- city with an override row enters ONLY while min ≤ ask ≤ max. The value constraints live HERE (the 0082 §6 /
-- 0093 idiom: routes TYPE-validate, VALUE constraints RAISE in the DB and surface verbatim in the UI).
--
-- WHAT:
--   1. config key SEMANTICS  — buy_table.city_price_ranges = a jsonb TEXT map {"<slug>": {"min": n, "max": n}}.
--                              NOT seeded: an absent key (or an absent slug inside it) means "no override —
--                              use the global [0, buy_table.price_cap]". The buy-table-tick handler parses it
--                              (parseBuyTableConfig.cityRanges) and applies the range at the candidate gate.
--   2. buy_table_price_range_set(p_city, p_min, p_max) — the operator write (SECURITY DEFINER, operator_guard):
--                              p_min/p_max BOTH null = CLEAR the city's override (stale slugs stay clearable —
--                              no existence check on the clear path); else the slug is normalized (lower/trim)
--                              and must exist in cities.slug (the 0093 RAISE idiom), and the range must satisfy
--                              0 ≤ min < max ≤ 0.99 — anything else RAISES verbatim. Upserts into the map.
--   3. buy_table_price_cap_set(p_max) — the GLOBAL cap write (operator_guard): 0 < max ≤ 0.99 or RAISE;
--                              writes buy_table.price_cap (the same key 0095 seeded and the tick reads).
--   4. dash_trading()         — re-stated VERBATIM from the 0096 body PLUS one addition inside `buyTable`:
--                              priceConfig = { globalMax (buy_table.price_cap::numeric, 0.15 fallback),
--                              cityRanges (the parsed map, {} when absent) }. Every other key byte-preserved.
--
-- Grants: both operator RPCs granted to service_role + authenticated (they SELF-GUARD via operator_guard,
-- like trade_config_set); revoked from public/anon. dash_trading grants re-asserted identical to 0096.
--
-- No table, no cron, no edge-fn change (cron count stays 35).
--
-- 0081 TRIPWIRE COMPLIANCE: both new RPCs return jsonb OBJECT envelopes ({cityPriceRanges: {...}} /
-- {priceCap: n}); dash_trading() stays an OBJECT; priceConfig is an OBJECT. No SETOF anywhere.
-- Idempotent-safe (create-or-replace everywhere; nothing seeded).
--
-- Rollback: drop function public.buy_table_price_range_set(text, numeric, numeric);
--           drop function public.buy_table_price_cap_set(numeric);
--           re-apply 0096 (create or replace function public.dash_trading() with the 0096 body);
--           delete from config where key = 'buy_table.city_price_ranges';
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · buy_table_price_range_set — the per-city [min, max] override write (0093 slug-validation idiom)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.buy_table_price_range_set(p_city text, p_min numeric, p_max numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_city text;
  v_map  jsonb;
begin
  perform public.operator_guard();

  -- 0093 normalization: the stored key is always lower(trim(slug)).
  v_city := lower(trim(coalesce(p_city, '')));
  if v_city = '' then
    raise exception 'buy_table_price_range_set: p_city is required (a cities.slug)';
  end if;

  -- null+null = clear; set needs BOTH bounds — a half-set range is ambiguous, never guessed.
  if (p_min is null) <> (p_max is null) then
    raise exception 'buy_table_price_range_set: p_min/p_max must be BOTH null (clear the override) or BOTH set — got min %, max %', p_min, p_max;
  end if;

  -- Read the current map FAIL-SOFT: an absent key or a hand-mangled value both read as "no overrides"
  -- (the handler's parseCityRanges applies the same tolerance — a broken map never blocks the operator write).
  begin
    v_map := coalesce((select value from public.config where key = 'buy_table.city_price_ranges'), '{}')::jsonb;
    if v_map is null or jsonb_typeof(v_map) <> 'object' then
      v_map := '{}'::jsonb;
    end if;
  exception when others then
    v_map := '{}'::jsonb;
  end;

  if p_min is null then
    -- CLEAR: drop the city's override. Deliberately NO cities.slug existence check here — a stale key for a
    -- renamed/removed city must stay clearable, and clearing a slug that has no override is a harmless no-op.
    v_map := v_map - v_city;
  else
    -- SET: the slug must exist in cities.slug (the 0093 RAISE idiom — the offender named verbatim)…
    if not exists (select 1 from public.cities c where c.slug = v_city) then
      raise exception 'buy_table_price_range_set: unknown city slug: % — must match cities.slug exactly', v_city;
    end if;
    -- …and the range must be a sane price interval: 0 ≤ min < max ≤ 0.99.
    if not (p_min >= 0 and p_min < p_max and p_max <= 0.99) then
      raise exception 'buy_table_price_range_set: invalid range [%, %] — need 0 <= min < max <= 0.99', p_min, p_max;
    end if;
    v_map := v_map || jsonb_build_object(v_city, jsonb_build_object('min', p_min, 'max', p_max));
  end if;

  insert into public.config (key, value) values ('buy_table.city_price_ranges', v_map::text)
  on conflict (key) do update set value = excluded.value, updated_at = now();

  return jsonb_build_object('cityPriceRanges', v_map);
end;
$$;

revoke all on function public.buy_table_price_range_set(text, numeric, numeric) from public, anon, authenticated;
grant  execute on function public.buy_table_price_range_set(text, numeric, numeric) to service_role, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · buy_table_price_cap_set — the GLOBAL cap write (buy_table.price_cap, the 0095 key)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.buy_table_price_cap_set(p_max numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.operator_guard();

  if p_max is null or not (p_max > 0 and p_max <= 0.99) then
    raise exception 'buy_table_price_cap_set: invalid cap % — need 0 < max <= 0.99', p_max;
  end if;

  insert into public.config (key, value) values ('buy_table.price_cap', p_max::text)
  on conflict (key) do update set value = excluded.value, updated_at = now();

  return jsonb_build_object('priceCap', p_max);
end;
$$;

revoke all on function public.buy_table_price_cap_set(numeric) from public, anon, authenticated;
grant  execute on function public.buy_table_price_cap_set(numeric) to service_role, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · dash_trading() — the 0096 body VERBATIM + buyTable.priceConfig { globalMax, cityRanges }
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
