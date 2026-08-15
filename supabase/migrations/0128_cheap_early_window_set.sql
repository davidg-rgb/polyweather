-- 0128: the cheap-early slim read takes a SET of DISJOINT windows, not one contiguous span.
--
-- WHY: 0126 gave cheap_early_capture_inputs a single [lo,hi] hours-to-close window. 0127 then registered a
-- variant that windows on [12,15] beside the canonical [24,36], and the panel asked for their contiguous UNION
-- [12,36] — which is not the union of what the variants read, it is that PLUS the dead 15–24h middle. Measured
-- on prod (2026-08-15): tokyo [24,36] = 733 captures / 0.8s · [12,15] = 328 / 0.6s · [12,36] = 1,492 / 2.5s.
-- Under the panel's 3-way concurrency the contiguous read ballooned to 10–36s per city → 10 cityErrors, a 287s
-- tick, and a statement_timeout on another job's claim_job_run. Fetching the SET in ONE call per city puts the
-- slice back at ~1.4x the [24,36] baseline instead of ~2x.
--
-- WHAT: p_windows — a FLAT double precision[] of [lo,hi,lo,hi,…] pairs (flat, not a 2-D array: PostgREST ships a
-- JSON number array cleanly and a ragged 2-D array is a runtime error waiting to happen). When non-null and at
-- least one whole pair long it TAKES PRECEDENCE over p_window_lo_h / p_window_hi_h; otherwise the old two-scalar
-- window still applies, so the 0126 call shape keeps working (the panel's staged 42883 fallback relies on it).
-- Each window keeps 0126's ±1h capture-cadence slack. Trailing unpaired elements are ignored.
--
-- The parameter LIST changes, so the 0126 4-arg overload must be DROPPED first — leaving both would make an
-- ambiguous-call risk out of a defaulted call, and PostgREST would have two candidates for the same name.
--
-- ROLLBACK: drop the 5-arg function and re-apply 0126_cheap_early_slim_inputs.sql verbatim (the panel's
-- fallback path already runs against that signature, so a rollback degrades to the contiguous read, not to a
-- dead tick).

drop function if exists public.cheap_early_capture_inputs(integer, text[], double precision, double precision);

create or replace function public.cheap_early_capture_inputs(
  p_days integer default 21,
  p_cities text[] default null::text[],
  p_window_lo_h double precision default 24,
  p_window_hi_h double precision default 36,
  p_windows double precision[] default null::double precision[]
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '40s'
as $function$
declare
  v        jsonb;
  v_days   int    := greatest(coalesce(p_days, 21), 1);
  v_cities text[] := coalesce(p_cities, array[]::text[]);
  -- the flat pair array actually used: p_windows when it carries at least one whole pair, else the legacy
  -- single window (0126's call shape). The ±1h slack is applied per window, below.
  v_pairs  double precision[] := case
             when p_windows is not null and coalesce(array_length(p_windows, 1), 0) >= 2 then p_windows
             else array[coalesce(p_window_lo_h, 24), coalesce(p_window_hi_h, 36)]::double precision[]
           end;
begin
  with win as (
    -- [lo,hi,lo,hi,…] → one row per pair, ±1h capture-cadence slack (0126). Unpaired tail element dropped;
    -- an inverted pair (hi < lo) is dropped rather than silently matching nothing surprising.
    select v_pairs[i] - 1 as lo, v_pairs[i + 1] + 1 as hi
      from generate_series(1, coalesce(array_length(v_pairs, 1), 0) - 1, 2) as g(i)
     where v_pairs[i] is not null
       and v_pairs[i + 1] is not null
       and v_pairs[i + 1] >= v_pairs[i]
  ),
  fresh as (
    select event_id
      from public.opening_captures
     where captured_at > now() - (v_days || ' days')::interval
       and event_id is not null
       and city = any(v_cities)
     group by event_id
    having min(hours_since_listing) < 1
  ),
  kept_ids as (
    select id from (
      select oc.id,
             extract(epoch from (oc.resolves_at - oc.captured_at)) / 3600.0 as htc,
             row_number() over (
               partition by oc.event_id
               order by oc.captured_at desc, oc.id desc
             ) as last_rn
      from public.opening_captures oc
      join fresh f on f.event_id = oc.event_id
      where oc.captured_at > now() - (v_days || ' days')::interval
    ) x
    where x.last_rn = 1
       or exists (select 1 from win w where x.htc >= w.lo and x.htc <= w.hi)
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
         'execBid', b->'execBid', 'bestBid', b->'bestBid', 'depthUsd', b->'depthUsd', 'houseProb', b->'houseProb',
         'conditionId', b->'conditionId', 'tokenYes', b->'tokenYes', 'tokenNo', b->'tokenNo')
       order by (b->>'idx')::int)
       from jsonb_array_elements(s.buckets) b)   as "buckets"
    from public.opening_captures s
    join kept_ids k on k.id = s.id
    order by s.event_id, s.captured_at
  ),
  res as (
    select
      me.id::text as "id",
      coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx)::int as "winnerIdx",
      (me.grading_mismatch = true)                                       as "gradingMismatch"
    from public.market_events me
    where me.id in (select event_id from fresh)
  )
  select jsonb_build_object(
    'captures',    coalesce((select jsonb_agg(to_jsonb(caps)) from caps), '[]'::jsonb),
    'resolutions', coalesce((select jsonb_agg(to_jsonb(res)) from res), '[]'::jsonb)
  ) into v;
  return v;
end;
$function$;

revoke all    on function public.cheap_early_capture_inputs(integer, text[], double precision, double precision, double precision[]) from public, anon, authenticated;
grant  execute on function public.cheap_early_capture_inputs(integer, text[], double precision, double precision, double precision[]) to service_role;

comment on function public.cheap_early_capture_inputs(integer, text[], double precision, double precision, double precision[]) is
  '0128: slim capture inputs for cheap-early-panel — a SET of disjoint hours-to-close windows (flat [lo,hi,…] p_windows, ±1h each) + last tick per event. Replaces 0126''s single contiguous window: the [12,15]∪[24,36] variant set was being read as [12,36], doubling the per-city rows (prod: 733→1,492 captures, 0.8s→2.5s) and blowing the tick to 287s / 10 cityErrors.';

-- PostgREST caches the function signature list — without this the first post-deploy call 404s/42883s (and the
-- panel would spend a tick on its fallback path).
notify pgrst, 'reload schema';
