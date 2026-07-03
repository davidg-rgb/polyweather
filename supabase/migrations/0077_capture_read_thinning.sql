-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0077 · capture read thinning — 20-min grid + last-tick retention per event, decided BEFORE any detoast
--
-- 2026-07-03 (WS-1, FASTTRACK-PLAN): opening_captures is 46 MB heap + ~1.2 GB TOAST (the `buckets` jsonb).
-- 0076 kept the TOAST out of the window SORT, but convergence_capture_inputs still detoasts every RETAINED
-- tick — and its 0069 `rn % 3` stride keeps ~⅓ of the window regardless of capture cadence, so one 45-city ×
-- 21-day maker-exit-panel tick pulled ~1.2 GB through a buffer cache smaller than that → every tick was
-- disk-bound (cityErrors ~41/45, 343–378 s ticks; the 45-city panel never had a clean tick).
--
-- The replay consumers only need ~20-MIN tick granularity: the §9R-E backtest replays the archive at a 20-min
-- cadence (SAMPLE_MIN = 20 in scripts/research/sim-maker-exit.ts — per-event-anchored, last-known-carried-
-- forward resampling, a DIFFERENT convention from a shared-clock grid, so the claim here is the same cadence
-- CLASS as the validated backtest, NOT an identical grid), while capture accrues at */10 (*/2 when fully
-- restored) — most of the detoasted volume was being discarded by the engine. The panel previously consumed
-- FULL tick density, so this thinning moves the panel CLOSER to the backtest convention, not away from it.
-- Fix: thin SERVER-SIDE to one row per event per 20-min epoch-aligned grid bucket — deterministic pick =
-- min captured_at (id tiebreak) per bucket — PLUS always the NEWEST tick per event (the 0069 invariant,
-- `rn = cnt` in its shape), via the 0076 slim-window-rank → PK-join-back pattern, so skipped rows are never
-- detoasted at all. ~2× less detoast at */10 capture, ~10× at */2 (the last-tick rule adds at most ONE row
-- per event). Fidelity invariants:
--   · the EARLIEST tick per event is the min of its own grid bucket → ALWAYS retained, so buildEvents' FRESH
--     re-check (min hours_since_listing sits at the first tick — opening-bracket-ingest.ts) still sees the
--     same min the SQL `having min(...) < 1` did (the 0069 invariant, preserved);
--   · the NEWEST tick per event is ALWAYS retained — the replay fires the hard time-stop per retained tick
--     and marks open positions to the LAST retained bid (opening-maker-exit-replay.ts), so dropping a live
--     event's freshest capture (its still-forming final grid bucket) would fire time-stops up to ~40 min
--     late at a different price and stale the open-position marks — a bias the live forward gate of record
--     must not carry.
--
-- Signature / output contract / grants BYTE-IDENTICAL to 0073/0076: (p_days int, p_cities text[]) → jsonb
-- OBJECT {captures, resolutions} with the 0073 bucket trim (incl. bestBid). Deliberately NO raw/unthinned
-- param: a new defaulted arg is a NEW OVERLOAD (the 0054/0058 overload trap — the fat 2-arg body would
-- linger and every existing 2-arg call would turn ambiguous), and the full-fidelity read already exists:
-- bot_capture_series (0066, untouched — the Phase-3 backtest contract). No table/cron/grant-surface change.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.convergence_capture_inputs(
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
  -- thin over SLIM columns only (id/event_id/captured_at — the fat `buckets` stays in TOAST until the kept
  -- ids are known; the 0076 pattern): ONE row per event per 20-min epoch grid bucket (deterministic pick =
  -- min captured_at, id tiebreak) PLUS the newest tick per event (last_rn = 1 — the 0069 `rn = cnt`
  -- invariant: the replay's time-stop check + open-position marks read the freshest retained tick). The
  -- earliest tick per event is the min of its bucket → always retained. Both windows rank slim columns only —
  -- no `buckets` reference here.
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
      -- DECISION-read fields (a future trim edit MUST keep all of these): idx, houseProb, execAsk, depthUsd,
      -- bestAsk, execBid (label is display-only). bestBid is the MAKER-EXIT spread diagnostic (0073) — added so
      -- observedEntry/ExitSpread (bestAsk − bestBid) is populated; the taker bracket replay ignores it.
      (select jsonb_agg(jsonb_build_object(
         'idx', b->'idx', 'label', b->'label', 'bestAsk', b->'bestAsk', 'execAsk', b->'execAsk',
         'execBid', b->'execBid', 'bestBid', b->'bestBid', 'depthUsd', b->'depthUsd', 'houseProb', b->'houseProb')
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
$$;

revoke all on function public.convergence_capture_inputs(int, text[]) from public, anon, authenticated;
grant  execute on function public.convergence_capture_inputs(int, text[]) to service_role;
