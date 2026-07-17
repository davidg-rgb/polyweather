-- 0103_google_replay_cache — INCREMENTAL REPLAY for the google-paper-panel (loop C27/C34, 2026-07-17).
--
-- WHY: the hourly Edge tick re-replays the FULL 21-day window in TS every run. Since the 07-07 capture
-- prune the window has been REFILLING, and the run grew 64s (07-12) → ~290s (07-17) with runs dying at
-- the ~400s isolate wall ("reaped by health-monitor: exceeded wall limit (ADR-12)") — every run dead by
-- ~07-24 untreated. A RESOLVED, non-grading-mismatch event's replay unit is DETERMINISTIC FOREVER
-- (captures frozen, resolution settled, cfg pinned via the cache key) — so the handler caches those
-- units here and re-replays only OPEN/new events each run (CPU ∝ open events, not the whole window).
--
-- Surfaces (all service-role; the table is RLS deny-all, ADR-13):
--   1. google_replay_cache                                — (event_id, cache_key) → replay unit jsonb
--   2. google_paper_event_index(p_days, p_cities)         — light per-event index of the fresh window
--                                                           {eventId, city, targetDate, resolved, gm}
--   3. google_replay_cache_read(p_cache_key, p_event_ids) — bulk unit read for the window's events
--   4. google_replay_cache_write(p_cache_key, p_rows)     — batch upsert + self-prune (35d / stale keys)
--   5. google_paper_inputs_v2(p_days, p_cities, p_event_ids) — 0086's inputs RPC + an event-id filter
--      (v1 stays untouched; the handler falls back to the full legacy path when any of these is absent)
--
-- ROLLBACK:
--   drop function if exists public.google_paper_inputs_v2(int, text[], text[]);
--   drop function if exists public.google_replay_cache_write(text, jsonb);
--   drop function if exists public.google_replay_cache_read(text, text[]);
--   drop function if exists public.google_paper_event_index(int, text[]);
--   drop table if exists public.google_replay_cache;

-- === 1. the cache table ==============================================================================
create table if not exists public.google_replay_cache (
  event_id   text        not null,
  cache_key  text        not null,
  replay     jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (event_id, cache_key)
);

-- RLS on (ADR-13): written/read only through the security-definer RPCs below; no policies = deny-all.
alter table public.google_replay_cache enable row level security;

-- === 2. google_paper_event_index — the light fresh-window index (same fresh rule as 0086) ============
create or replace function public.google_paper_event_index(
  p_days   int    default 21,
  p_cities text[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '40s'
as $$
  with fresh as (
    select event_id
      from public.opening_captures
     where captured_at > now() - (greatest(coalesce(p_days, 21), 1) || ' days')::interval
       and event_id is not null
       and city = any(coalesce(p_cities, array[]::text[]))
     group by event_id
    having min(hours_since_listing) < 1
  ),
  meta as (
    select distinct on (oc.event_id) oc.event_id, oc.city, oc.target_date
    from public.opening_captures oc
    join fresh f on f.event_id = oc.event_id
    order by oc.event_id, oc.captured_at
  )
  select jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
           'eventId',    m.event_id::text,
           'city',       m.city,
           'targetDate', m.target_date::text,
           'resolved',   (coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx) is not null),
           'gm',         (me.grading_mismatch = true)
         )), '[]'::jsonb))
  from meta m
  left join public.market_events me on me.id = m.event_id;
$$;

revoke all on function public.google_paper_event_index(int, text[]) from public, anon, authenticated;
grant  execute on function public.google_paper_event_index(int, text[]) to service_role;

-- === 3. google_replay_cache_read — bulk unit read for the window ====================================
create or replace function public.google_replay_cache_read(p_cache_key text, p_event_ids text[])
returns jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '40s'
as $$
  select jsonb_build_object('rows', coalesce(jsonb_agg(c.replay), '[]'::jsonb))
  from public.google_replay_cache c
  where c.cache_key = p_cache_key
    and c.event_id = any(coalesce(p_event_ids, array[]::text[]));
$$;

revoke all on function public.google_replay_cache_read(text, text[]) from public, anon, authenticated;
grant  execute on function public.google_replay_cache_read(text, text[]) to service_role;

-- === 4. google_replay_cache_write — batch upsert + self-prune =======================================
-- p_rows = jsonb ARRAY of replay units (each carrying its own eventId). Rows without an eventId are
-- skipped. Self-prunes: anything untouched for 35 days (fell out of every plausible window), and rows
-- under a DIFFERENT cache key untouched for 7 days (a cfg/engine bump superseded them).
create or replace function public.google_replay_cache_write(p_cache_key text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = '40s'
as $$
declare n integer := 0;
begin
  if p_cache_key is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return 0;
  end if;
  insert into public.google_replay_cache (event_id, cache_key, replay)
  select r->>'eventId', p_cache_key, r
    from jsonb_array_elements(p_rows) r
   where coalesce(r->>'eventId', '') <> ''
  on conflict (event_id, cache_key) do update
    set replay = excluded.replay, updated_at = now();
  get diagnostics n = row_count;
  delete from public.google_replay_cache
   where updated_at < now() - interval '35 days'
      or (cache_key <> p_cache_key and updated_at < now() - interval '7 days');
  return n;
end;
$$;

revoke all on function public.google_replay_cache_write(text, jsonb) from public, anon, authenticated;
grant  execute on function public.google_replay_cache_write(text, jsonb) to service_role;

-- === 5. google_paper_inputs_v2 — 0086's inputs RPC + an event-id filter ==============================
-- Byte-identical to google_paper_inputs except the fresh CTE also honors p_event_ids (null = all, the
-- v1 behavior). A NEW function (not a replace) so the v1 signature — and every existing caller — stays
-- untouched; the handler prefers v2 and staged-dark-falls-back to v1 when it is absent.
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
       and (p_event_ids is null or event_id = any(p_event_ids))
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
