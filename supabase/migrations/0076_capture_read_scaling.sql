-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0076 · capture read-path scaling, part 2 — keep the TOASTed payload OUT of the window sorts
--
-- 2026-07-03 (overnight loop): both capture readers window-rank `oc.*` — including the ~3.4 KB TOASTed
-- `buckets` jsonb — BEFORE their row filters, so the sort materializes/detoasts every tick in scope:
--
--   · bot_spike_series (0068): the 8-day/45-city read shuffled ~1.2 GB through one window sort. On the small
--     prod instance the statement ran for many minutes, saturated the pooler (collateral statement-timeout
--     500s in unrelated edge functions), and twice died server-side while the caller hung on the dead socket.
--     The Phase-0.5 spike no longer calls it (it reads two-stage direct SQL), but the RPC as it stood was a
--     standing DoS-on-ourselves trap for any future caller.
--   · convergence_capture_inputs (0069/0073): the same shape per city — every fresh event's FULL 21-day tick
--     series is detoasted + sorted before the `rn % 3` downsample keeps ~⅓ of it. This is the ~3–8 s/city that
--     (× 45 sequential cities) pushed the maker-exit-panel tick past the ~400 s isolate wall on 2026-07-02.
--
-- Fix, both bodies, same pattern: rank SLIM columns only (id / event_id / captured_at — no detoast in the
-- sort), filter to the retained ids, then join back to opening_captures by PRIMARY KEY for the fat payload.
-- Signatures, output contracts, grants, and every returned field are byte-identical — the PGlite twins for
-- 0068 (spike cap) and 0073 (bestBid in the trimmed buckets) run unchanged against this chain.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1 · bot_spike_series — slim-window body (contract identical to 0068) ────────────────────────────────
create or replace function public.bot_spike_series(p_days int, p_cap int default 40)
returns jsonb
language sql
security definer
set search_path = public
as $$
  -- rank over slim columns (no `buckets` detoast in the window sort), THEN fetch the fat rows by PK.
  with head_ids as (
    select id from (
      select id, row_number() over (partition by event_id order by captured_at) as rn
      from public.opening_captures
      where captured_at >= now() - make_interval(days => greatest(coalesce(p_days, 14), 1))
    ) x
    where rn <= greatest(coalesce(p_cap, 40), 1)
  )
  -- jsonb OBJECT { rows: [...] }, never a top-level array (the 0044 port-misread trap — see bot_capture_series).
  select jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
    'eventId', oc.event_id, 'capturedAt', oc.captured_at, 'city', oc.city, 'targetDate', oc.target_date,
    'tzName', oc.tz_name, 'createdAtGamma', oc.created_at_gamma, 'resolvesAt', oc.resolves_at,
    'hoursSinceListing', oc.hours_since_listing, 'peakMid', oc.peak_mid, 'isFlatOpen', oc.is_flat_open,
    'houseSeeded', oc.house_seeded, 'buckets', oc.buckets, 'evVol24h', oc.ev_vol24h, 'negRisk', oc.neg_risk
  ) order by oc.event_id, oc.captured_at), '[]'::jsonb))
  from public.opening_captures oc
  join head_ids h on h.id = oc.id;
$$;

revoke all on function public.bot_spike_series(int, int) from public, anon, authenticated;
grant  execute on function public.bot_spike_series(int, int) to service_role;

-- ── 2 · convergence_capture_inputs — slim-window body (contract identical to 0073) ──────────────────────
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
  -- rank + downsample over SLIM columns only (id/event_id/captured_at — the fat `buckets` stays in TOAST
  -- until the retained ids are known; 0069/0073 ranked oc.* and detoasted the whole 21-day series first).
  kept_ids as (
    select id from (
      select oc.id,
             row_number() over (partition by oc.event_id order by oc.captured_at) as rn,
             count(*)     over (partition by oc.event_id)                          as cnt
      from public.opening_captures oc
      join fresh f on f.event_id = oc.event_id
      where oc.captured_at > now() - (v_days || ' days')::interval
    ) x
    -- downsample to ~every 3rd tick (≈6-min) + always the last tick; the replay is robust to ~6-min granularity.
    where x.rn % 3 = 1 or x.rn = x.cnt
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
