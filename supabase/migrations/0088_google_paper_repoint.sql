-- 0088_google_paper_repoint.sql — THE CUTOVER (v2): repoint google_paper_inputs off opening_captures onto the
-- dedicated `market_depth` table (0089), with an AUTOMATIC, SELF-GATING source switch.
--
-- WHY v2 (vs the discarded v1 repoint). The v1 0088 read market_snapshots.depth and reconstructed the listing
-- anchor + entry-age from market_events.first_seen (INGESTION time). The 5-agent review confirmed that break the
-- flat-open gate (near-tautological) + admitted late entries (finding A/parity), plus a partial per-tick ladder
-- silently dropped events (finding F) and a blanket `db push` could cut over prematurely with only a prose caveat
-- (finding J). This rewrite fixes all three and adds a TECHNICAL cutover guard. Spec: DEPTH-CAPTURE-V2-HANDOFF.md.
--
-- THE FIXES:
--   • TRUE listing anchor (§4.3 / finding A): hoursSinceListing = captured_at − market_events.gamma_created_at (the
--     real Gamma createdAt, threaded by 0089's upsert_event), NOT first_seen. createdAtGamma = gamma_created_at.
--   • COMPLETE ladder per tick (§4.4 / finding F): LEFT JOIN ALL of the event's market_buckets and attach exec
--     prices where a market_depth row exists at that tick, execAsk/execBid null where not — so the bucketer
--     (googleBucketIdx) always sees the full ladder and never drops the event on a partial walk.
--   • SELF-GATING cutover (§4.8 / finding J): google_paper_inputs FALLS BACK to google_paper_inputs_opening (the
--     preserved 0086 body, still reading the revived opening_captures) until market_depth exists AND holds ≥
--     bot.depthCutoverMinRows rows. So applying this migration early is HARMLESS — the panel auto-switches source
--     only once real depth has accrued. A premature `db push` can no longer silently cut over onto an empty source.
--     ROLLBACK is a config flip, no migration: `update config set value='999999999' where key='bot.depthCutoverMinRows'`
--     forces the opening_captures path immediately.
--   • resolvesAt = target_date 12:00 UTC (the uniform venue rule — verified across every tz; refuted-HIGH, kept).
--   • peakMid/isFlatOpen/houseSeeded/houseProb are convergence-signal fields the pure GOOGLE engine IGNORES —
--     defaulted here (shape-parity only). The res/ev_meta/google blocks read market_events/source_forecasts (not
--     the capture source), so they are shared by both paths.
--
-- Same signature + same {captures, resolutions, google} shape buildGoogleView consumes.

-- === 1. google_paper_inputs_opening — the PRESERVED 0086 body (opening_captures) — fallback + rollback path ==
-- Byte-for-byte the 0086 google_paper_inputs logic. Kept as a named function so the guard below can delegate to it
-- (the revived opening-capture still writes opening_captures, so this stays a live, valid source), and so reverting
-- the cutover is trivial (force the fallback via config, or point google_paper_inputs straight at this).
create or replace function public.google_paper_inputs_opening(
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
  with fresh as (
    select event_id
      from public.opening_captures
     where captured_at > now() - (v_days || ' days')::interval
       and event_id is not null
       and city = any(v_cities)
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

revoke all on function public.google_paper_inputs_opening(int, text[]) from public, anon, authenticated;
grant  execute on function public.google_paper_inputs_opening(int, text[]) to service_role;

-- === 2. google_paper_inputs — the guarded cutover: market_depth when it has accrued, else opening_captures ===
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
  v            jsonb;
  v_days       int    := greatest(coalesce(p_days, 21), 1);
  v_cities     text[] := coalesce(p_cities, array[]::text[]);
  -- SELF-GATING cutover guard (finding J): stay on opening_captures until market_depth EXISTS and holds ≥ this many
  -- rows. Config-overridable so the operator can force either path with NO migration (rollback = set it very high).
  v_min_rows   int    := coalesce((select value::int from config where key = 'bot.depthCutoverMinRows'), 200);
  v_depth_n    int;
begin
  -- table-missing (0089 not yet applied) OR under the accrual threshold → the preserved opening_captures path.
  if to_regclass('public.market_depth') is null then
    return public.google_paper_inputs_opening(p_days, p_cities);
  end if;
  select count(*) into v_depth_n from (select 1 from public.market_depth limit greatest(v_min_rows, 1)) t;
  if v_depth_n < v_min_rows then
    return public.google_paper_inputs_opening(p_days, p_cities);
  end if;

  -- ── the market_depth path (post-cutover) ──────────────────────────────────────────────────────────────────
  with
  -- FRESH events (the entry-rule population): min hoursSinceListing < 1, anchored to the TRUE Gamma listing time
  -- (gamma_created_at, NOT first_seen — finding A). Depth rows only; scoped to the panel's cities.
  fresh as (
    select mb.event_id
    from public.market_depth   md
    join public.market_buckets mb on mb.id = md.bucket_id
    join public.market_events  me on me.id = mb.event_id
    join public.cities         c  on c.id = me.city_id
    where md.captured_at > now() - (v_days || ' days')::interval
      and me.kind = 'highest'
      and me.gamma_created_at is not null
      and c.slug = any(v_cities)
    group by mb.event_id
    having min(extract(epoch from (md.captured_at - me.gamma_created_at)) / 3600.0) < 1
  ),
  -- every (event, tick) at which ANY bucket was walked. NOT downsampled: the delta-fed market_depth is already
  -- thin, and downsampling risks dropping the exact tick a bucket first entered the cheap band.
  depth_ticks as (
    select distinct mb.event_id, md.captured_at
    from public.market_depth   md
    join public.market_buckets mb on mb.id = md.bucket_id
    where md.captured_at > now() - (v_days || ' days')::interval
      and mb.event_id in (select event_id from fresh)
  ),
  caps as (
    -- COMPLETE ladder per tick (finding F): join ALL of the event's market_buckets, LEFT JOIN the depth row at that
    -- exact captured_at — execAsk/execBid come from the walked depth where present, null where not; bestAsk/bestBid
    -- are top-of-book; depthUsd is carried for shape-parity (the GOOGLE engine ignores houseProb + depthUsd).
    select
      me.id::text                                                            as "eventId",
      dt.captured_at::text                                                   as "capturedAt",
      c.slug                                                                 as "city",
      me.target_date::text                                                   as "targetDate",
      c.tz                                                                   as "tzName",
      me.gamma_created_at::text                                              as "createdAtGamma",
      ((me.target_date + interval '12 hours') at time zone 'utc')::text      as "resolvesAt",
      (extract(epoch from (dt.captured_at - me.gamma_created_at)) / 3600.0)::float8 as "hoursSinceListing",
      null::float8                                                           as "peakMid",
      false                                                                  as "isFlatOpen",
      false                                                                  as "houseSeeded",
      me.volume24h::float8                                                   as "evVol24h",
      (me.neg_risk_market_id is not null)                                    as "negRisk",
      jsonb_agg(jsonb_build_object(
        'idx',       mb.bucket_idx,
        'label',     mb.label,
        'bestAsk',   md.best_ask,
        'execAsk',   md.exec_ask,
        'execBid',   md.exec_bid,
        'bestBid',   md.best_bid,
        'depthUsd',  md.depth_usd,
        'houseProb', null
      ) order by mb.bucket_idx)                                              as "buckets"
    from depth_ticks dt
    join public.market_events   me on me.id = dt.event_id
    join public.cities          c  on c.id = me.city_id
    join public.market_buckets  mb on mb.event_id = me.id
    left join public.market_depth md on md.bucket_id = mb.id and md.captured_at = dt.captured_at
    group by me.id, dt.captured_at, c.slug, me.target_date, c.tz, me.gamma_created_at, me.volume24h, me.neg_risk_market_id
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
