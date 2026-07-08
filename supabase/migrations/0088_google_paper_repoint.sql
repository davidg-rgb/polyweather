-- 0088_google_paper_repoint.sql — THE CUTOVER: rewrite google_paper_inputs to read market_snapshots.depth (0087).
--
-- Apply this ONLY after 0087 is applied, the depth-capture edge fn is deployed, and `market_snapshots.depth` has
-- accrued enough that a parity check vs the (revived) opening_captures path looks sane — see the handoff. Until
-- then the /convergence Google panel keeps running on its 0086 RPC (opening_captures). This is the single, cleanly
-- reversible step that flips the panel's source; `create or replace` means reverting = re-applying 0086's body.
--
-- Same signature + same {captures, resolutions, google} shape buildGoogleView consumes. The capture series now
-- comes from market_snapshots (depth rows only) regrouped per (event, tick) via jsonb_agg; the event-level fields
-- opening_captures stored inline are reconstructed: createdAtGamma/hoursSinceListing from market_events.first_seen,
-- resolvesAt from target_date 12:00 UTC (the uniform venue rule, verified across every tz). peakMid/isFlatOpen/
-- houseSeeded/houseProb are the convergence-signal fields the pure GOOGLE engine IGNORES — defaulted here (shape-
-- parity only). The `res` + `google` blocks are the 0086 logic (they already read market_events / source_forecasts).
create or replace function public.google_paper_inputs(
  p_days   int    default 21,
  p_cities text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '40s'
as $$
declare
  v        jsonb;
  v_days   int    := greatest(coalesce(p_days, 21), 1);
  v_cities text[] := coalesce(p_cities, array[]::text[]);
begin
  with
  -- FRESH events (the entry-rule population): min hoursSinceListing < 1, where hoursSinceListing is the walked
  -- tick's age since the market's first_seen (the listing proxy). depth rows only; scoped to the panel's cities.
  fresh as (
    select mb.event_id
    from public.market_snapshots ms
    join public.market_buckets mb on mb.id = ms.bucket_id
    join public.market_events   me on me.id = mb.event_id
    join public.cities          c  on c.id = me.city_id
    where ms.depth is not null
      and ms.captured_at > now() - (v_days || ' days')::interval
      and me.kind = 'highest'
      and me.first_seen is not null
      and c.slug = any(v_cities)
    group by mb.event_id
    having min(extract(epoch from (ms.captured_at - me.first_seen)) / 3600.0) < 1
  ),
  -- distinct (event, tick) tuples, downsampled to ~every-3rd tick + always the last (the replay is robust to the
  -- coarser grain; keeps the per-city payload small at */5 over the 21d window).
  tick_rank as (
    select d.event_id, d.captured_at,
           row_number() over (partition by d.event_id order by d.captured_at) as rn,
           count(*)     over (partition by d.event_id)                        as cnt
    from (
      select distinct mb.event_id, ms.captured_at
      from public.market_snapshots ms
      join public.market_buckets mb on mb.id = ms.bucket_id
      where ms.depth is not null
        and ms.captured_at > now() - (v_days || ' days')::interval
        and mb.event_id in (select event_id from fresh)
    ) d
  ),
  kept as (select event_id, captured_at from tick_rank where rn % 3 = 1 or rn = cnt),
  caps as (
    select
      me.id::text                                                            as "eventId",
      ms.captured_at::text                                                   as "capturedAt",
      c.slug                                                                 as "city",
      me.target_date::text                                                   as "targetDate",
      c.tz                                                                   as "tzName",
      me.first_seen::text                                                    as "createdAtGamma",
      ((me.target_date + interval '12 hours') at time zone 'utc')::text      as "resolvesAt",
      (extract(epoch from (ms.captured_at - me.first_seen)) / 3600.0)::float8 as "hoursSinceListing",
      null::float8                                                           as "peakMid",
      false                                                                  as "isFlatOpen",
      false                                                                  as "houseSeeded",
      me.volume24h::float8                                                   as "evVol24h",
      (me.neg_risk_market_id is not null)                                    as "negRisk",
      -- regroup the tick's per-bucket rows into the RawBucket[] the engine reads. execAsk (the <askMax entry gate)
      -- + execBid (the absolute TP/SL exit) come from the walked depth; bestAsk/bestBid are top-of-book; depthUsd
      -- is carried for shape-parity; houseProb is null (the GOOGLE engine ignores houseProb + depthUsd entirely).
      jsonb_agg(jsonb_build_object(
        'idx',      mb.bucket_idx,
        'label',    mb.label,
        'bestAsk',  ms.best_ask,
        'execAsk',  ms.depth->'execAsk',
        'execBid',  ms.depth->'execBid',
        'bestBid',  ms.best_bid,
        'depthUsd', ms.depth->'depthUsd',
        'houseProb', null
      ) order by mb.bucket_idx)                                              as "buckets"
    from public.market_snapshots ms
    join public.market_buckets mb on mb.id = ms.bucket_id
    join kept k                   on k.event_id = mb.event_id and k.captured_at = ms.captured_at
    join public.market_events   me on me.id = mb.event_id
    join public.cities          c  on c.id = me.city_id
    where ms.depth is not null
    group by me.id, ms.captured_at, c.slug, me.target_date, c.tz, me.first_seen, me.volume24h, me.neg_risk_market_id
  ),
  res as (
    select
      me.id::text as "id",
      coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx)::int as "winnerIdx",
      (me.grading_mismatch = true)                                       as "gradingMismatch"
    from public.market_events me
    where me.id in (select event_id from fresh)
  ),
  ev_meta as (
    select me.id as event_id, c.slug as city, me.target_date, c.id as city_id, c.unit, c.tz
    from public.market_events me
    join public.cities c on c.id = me.city_id
    where me.id in (select event_id from fresh)
  ),
  google as (
    select
      em.event_id::text as "eventId",
      em.unit           as "unit",
      em.tz             as "tz",
      (
        select sf.tmax_c::float8
        from public.source_forecasts sf
        where sf.source = 'google'
          and sf.icao   = cs.icao
          and sf.target_date = em.target_date
        order by sf.captured_at desc
        limit 1
      )                 as "tmaxC"
    from ev_meta em
    left join public.city_stations cs on cs.city_id = em.city_id and cs.valid_to is null
  )
  select jsonb_build_object(
    'captures',    coalesce((select jsonb_agg(to_jsonb(caps))   from caps),   '[]'::jsonb),
    'resolutions', coalesce((select jsonb_agg(to_jsonb(res))    from res),    '[]'::jsonb),
    'google',      coalesce((select jsonb_agg(to_jsonb(google)) from google), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;

revoke all on function public.google_paper_inputs(int, text[]) from public, anon, authenticated;
grant  execute on function public.google_paper_inputs(int, text[]) to service_role;
