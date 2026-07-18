-- 0107_city_predictions_market_link.sql — /cities rows carry the Polymarket event slug (operator ask).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY: the operator wants each open-market row on /cities to CLICK THROUGH to the live Polymarket book
-- (https://polymarket.com/event/{slug}, e.g. …/highest-temperature-in-chongqing-on-july-18-2026).
-- market_events.slug already stores exactly that event slug (0004; unique not null — it is the discovery
-- key), so this is a pure additive re-create of dash_city_predictions(): the open-rows jsonb gains one
-- 'slug' field sourced from the driving market_events row. No new table, no trigger, no cron change; the
-- stats half, the config half, grants and the operator_guard posture are byte-identical to 0106 §5.
--
-- Deploy-order safe both ways: the pre-0107 page ignores the extra field; the post-0107 page falls back to
-- reconstructing the canonical slug (full-month 'highest-…' — the only pattern the gamma parser admits into
-- the capture universe) if the RPC predates this migration.
--
-- Rollback: re-run 0106 §5 (the previous create or replace of dash_city_predictions()).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.dash_city_predictions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_stats jsonb;
  v_rows  jsonb;
  v_cfg   jsonb;
begin
  perform public.operator_guard();

  -- (a) live buy-window/price-cap tunables (buy_table.* config) so the page highlight tracks the lane's
  -- real config. Fail-safe: a malformed hand-edited value falls back to the 0095 defaults, never a throw.
  begin
    v_cfg := jsonb_build_object(
      'leadMinH', coalesce((select value::numeric from public.config where key = 'buy_table.lead_min_h'), 2),
      'leadMaxH', coalesce((select value::numeric from public.config where key = 'buy_table.lead_max_h'), 12),
      'priceCap', coalesce((select value::numeric from public.config where key = 'buy_table.price_cap'), 0.15)
    );
  exception when others then
    v_cfg := jsonb_build_object('leadMinH', 2, 'leadMaxH', 12, 'priceCap', 0.15);
  end;

  -- (b) per-city historic success rate over the folded grades. mismatch rows and unseeded predictions
  -- (hit IS NULL) are excluded from the rate; n is ALWAYS carried so the page can render "62% (n=18)"
  -- and grey out small samples (the entry-watch shrinkage lesson — never a bare small-n percentage).
  select coalesce(jsonb_agg(jsonb_build_object(
           'city',           s.city,
           'displayName',    coalesce(c.display_name, s.city),
           'unit',           c.unit,
           'n',              s.n,
           'hits',           s.hits,
           'rate',           case when s.n > 0 then round(s.hits::numeric / s.n, 4) end,
           'lastGradedDate', s.last_date
         ) order by s.city), '[]'::jsonb)
  into v_stats
  from (
    select g.city,
           count(*) filter (where g.hit is not null) as n,
           count(*) filter (where g.hit)             as hits,
           max(g.target_date)                        as last_date
    from public.city_prediction_grades g
    where not g.mismatch
    group by g.city
  ) s
  left join public.cities c on c.slug = s.city;

  -- (c) one row per OPEN captured market: driven from the market_events partial open index; ONE LIMIT-1
  -- lateral per event via oc_event_captured_idx (never a capture scan — the 0098/0099/0100 law).
  -- 0107: + 'slug' (the Polymarket EVENT slug from the driving market_events row) so the page can link
  -- each row to its live book at https://polymarket.com/event/{slug}.
  select coalesce(jsonb_agg(jsonb_build_object(
           'city',        lower(trim(oc.city)),
           'displayName', coalesce(c.display_name, lower(trim(oc.city))),
           'unit',        c.unit,
           'slug',        me.slug,
           'targetDate',  oc.target_date,
           'resolvesAt',  oc.resolves_at,
           'capturedAt',  oc.captured_at,
           'predIdx',     pb.idx,
           'predLabel',   pb.label,
           'predProb',    pb.prob,
           'ask',         pb.ask
         ) order by oc.resolves_at, lower(trim(oc.city))), '[]'::jsonb)
  into v_rows
  from public.market_events me
  join public.cities c on c.id = me.city_id
  cross join lateral (
    -- the event's LATEST capture — the page's current view of the market.
    select oc2.city, oc2.target_date, oc2.resolves_at, oc2.captured_at, oc2.buckets
    from public.opening_captures oc2
    where oc2.event_id = me.id
    order by oc2.captured_at desc
    limit 1
  ) oc
  left join lateral (
    -- the SAME pick as the fold + the live lane: argmax houseProb, identity-complete; ITS
    -- execAsk→bestAsk (never the next-best bucket's) — the 0100 gate-price idiom.
    select (b.value->>'idx')::int           as idx,
           b.value->>'label'                as label,
           (b.value->>'houseProb')::numeric as prob,
           case when jsonb_typeof(b.value->'execAsk') = 'number' then (b.value->>'execAsk')::numeric
                when jsonb_typeof(b.value->'bestAsk') = 'number' then (b.value->>'bestAsk')::numeric
           end as ask
    from jsonb_array_elements(
           case when jsonb_typeof(oc.buckets) = 'array' then oc.buckets else '[]'::jsonb end) b
    where jsonb_typeof(b.value->'houseProb') = 'number'
      and coalesce(b.value->>'conditionId', '') <> ''
      and coalesce(b.value->>'tokenYes', '')    <> ''
    order by (b.value->>'houseProb')::numeric desc
    limit 1
  ) pb on true
  where not me.closed
    and coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx) is null
    and me.target_date >= current_date - 1
    and oc.resolves_at > now();

  return jsonb_build_object(
    'generatedAt', now(),
    'config',      v_cfg,
    'stats',       v_stats,
    'rows',        v_rows
  );
end;
$$;

revoke all on function public.dash_city_predictions() from public, anon, authenticated;
grant  execute on function public.dash_city_predictions() to authenticated, service_role;
