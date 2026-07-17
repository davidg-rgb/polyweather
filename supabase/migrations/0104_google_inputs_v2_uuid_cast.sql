-- 0104_google_inputs_v2_uuid_cast — HOTFIX for 0103's google_paper_inputs_v2 (loop C35, 2026-07-17).
--
-- The 0103 event filter compared `event_id = any(p_event_ids text[])` — but opening_captures.event_id
-- is UUID, so EVERY event-filtered call raised `operator does not exist: uuid = text` (42883). The
-- 10:24Z first incremental tick failed all 45 city fetches (cityErrors=45) and recorded an EMPTY view.
-- PGlite could not catch it: the throw is runtime-only, on the p_event_ids branch, against the uuid
-- column — the migrations suite now exercises exactly that call shape. Fix: `event_id::text = any(...)`.
--
-- ROLLBACK: re-apply 0103's google_paper_inputs_v2 body (the uncast comparison).

create or replace function public.google_paper_inputs_v2(
  p_days      int    default 21,
  p_cities    text[] default null,
  p_event_ids text[] default null
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
  with fresh as (
    select event_id
      from public.opening_captures
     where captured_at > now() - (v_days || ' days')::interval
       and event_id is not null
       and city = any(v_cities)
       and (p_event_ids is null or event_id::text = any(p_event_ids))
     group by event_id
    having min(hours_since_listing) < 1
  ),
  ranked as (
    select oc.*,
           row_number() over (partition by oc.event_id order by oc.captured_at) as rn,
           count(*)     over (partition by oc.event_id)                          as cnt
    from public.opening_captures oc
    join fresh f on f.event_id = oc.event_id
    where oc.captured_at > now() - (v_days || ' days')::interval
  ),
  caps as (
    select
      s.event_id::text                 as "eventId",
      s.captured_at::text              as "capturedAt",
      s.city                           as "city",
      s.target_date::text              as "targetDate",
      s.tz_name                        as "tzName",
      s.created_at_gamma::text         as "createdAtGamma",
      s.resolves_at::text              as "resolvesAt",
      s.hours_since_listing::float8    as "hoursSinceListing",
      s.peak_mid::float8               as "peakMid",
      s.is_flat_open                   as "isFlatOpen",
      s.house_seeded                   as "houseSeeded",
      s.ev_vol24h::float8              as "evVol24h",
      s.neg_risk                       as "negRisk",
      (select jsonb_agg(jsonb_build_object(
         'idx', b->'idx', 'label', b->'label', 'bestAsk', b->'bestAsk', 'execAsk', b->'execAsk',
         'execBid', b->'execBid', 'bestBid', b->'bestBid', 'depthUsd', b->'depthUsd', 'houseProb', b->'houseProb')
       order by (b->>'idx')::int)
       from jsonb_array_elements(s.buckets) b)   as "buckets"
    from ranked s
    where s.rn % 3 = 1 or s.rn = s.cnt
    order by s.event_id, s.captured_at
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
    select distinct on (oc.event_id)
           oc.event_id, oc.city, oc.target_date
    from public.opening_captures oc
    join fresh f on f.event_id = oc.event_id
    order by oc.event_id, oc.captured_at
  ),
  google as (
    select
      em.event_id::text as "eventId",
      c.unit            as "unit",
      c.tz              as "tz",
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
    join public.cities c on c.slug = em.city
    left join public.city_stations cs on cs.city_id = c.id and cs.valid_to is null
  )
  select jsonb_build_object(
    'captures',    coalesce((select jsonb_agg(to_jsonb(caps))   from caps),   '[]'::jsonb),
    'resolutions', coalesce((select jsonb_agg(to_jsonb(res))    from res),    '[]'::jsonb),
    'google',      coalesce((select jsonb_agg(to_jsonb(google)) from google), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;

revoke all on function public.google_paper_inputs_v2(int, text[], text[]) from public, anon, authenticated;
grant  execute on function public.google_paper_inputs_v2(int, text[], text[]) to service_role;
