-- 0083_capture_inputs_identity.sql — add the bucket IDENTITY fields to convergence_capture_inputs().
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY (found live 2026-07-05, first dry-run daemon start): the RPC was built for the ECONOMICS replay
-- (convergence-panel / maker-exit-panel) and its bucket JSON carries only idx/label/prices/depth/houseProb —
-- it STRIPS tokenYes/tokenNo/conditionId. The T2 trade daemon (scripts/trade-bot.ts) discovers candidates
-- through this same RPC and needs the venue identity to place (dry-run or live) orders: with the stripped
-- shape every EntryCandidate mapped to conditionId=''/tokenYes='' → the venue rejected every book read with
-- "Invalid token id". ADDITIVE ONLY: three keys join the per-bucket object; every existing consumer's mapper
-- (core mapBucket) already reads-or-defaults them, and extra keys are ignored by older readers.
-- Body otherwise byte-identical to the live 0077-era definition (fresh CTE, 20-min grid keep, resolutions).
-- Verify after apply:
--   select jsonb_object_keys((convergence_capture_inputs(2, array['amsterdam'])->'captures'->0->'buckets'->0))
--   — must include conditionId, tokenYes, tokenNo.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.convergence_capture_inputs(p_days integer default 21, p_cities text[] default null::text[])
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
             row_number() over (
               partition by oc.event_id, floor(extract(epoch from oc.captured_at) / 1200)
               order by oc.captured_at, oc.id
             ) as grid_rn,
             row_number() over (
               partition by oc.event_id
               order by oc.captured_at desc, oc.id desc
             ) as last_rn
      from public.opening_captures oc
      join fresh f on f.event_id = oc.event_id
      where oc.captured_at > now() - (v_days || ' days')::interval
    ) x
    where x.grid_rn = 1 or x.last_rn = 1
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
         -- 0083: the venue identity — required by the trade daemon's candidate discovery + reconstruction.
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
