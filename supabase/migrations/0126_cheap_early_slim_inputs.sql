-- 0126: dedicated SLIM inputs for the cheap-early forward panel.
--
-- WHY: cheap-early-panel fed itself through convergence_capture_inputs — the FULL 20-min tick grid
-- over p_days × city, built for the convergence/maker-exit path panels that genuinely need every
-- tick. The cheap-early replay does not: its entry rule reads only the [24,36]h-to-close window
-- (it enters at the LATEST allowable tick), and its open-position mark + winner-label lookup need
-- only each event's last tick. Shipping the full grid cost ~6s/city and grew with the 46-city
-- all-day capture volume until per-city calls outgrew the panel's fetch budget: cityErrors climbed
-- 0 (2026-08-02) → 46/46 (2026-08-11) and the forward gate instrument sat at 0 entries while the
-- live lane traded. This function ships just the needed slice — same envelope shape (captures /
-- resolutions) so the panel's ingest is unchanged.
--
-- The ±1h guard band around the frozen [24,36] window (handoff §0) absorbs capture-cadence jitter;
-- the window bounds are parameters so a re-registered window never needs a new migration.

create or replace function public.cheap_early_capture_inputs(
  p_days integer default 21,
  p_cities text[] default null::text[],
  p_window_lo_h double precision default 24,
  p_window_hi_h double precision default 36
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
  v_lo     double precision := coalesce(p_window_lo_h, 24) - 1;
  v_hi     double precision := coalesce(p_window_hi_h, 36) + 1;
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
    where x.last_rn = 1 or (x.htc >= v_lo and x.htc <= v_hi)
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

comment on function public.cheap_early_capture_inputs(integer, text[], double precision, double precision) is
  '0126: slim capture inputs for cheap-early-panel — [24,36]h window slice (±1h) + last tick per event. Same envelope as convergence_capture_inputs; built because the full-grid read outgrew the panel fetch budget (cityErrors 0→46, gate starved at 0 entries).';
