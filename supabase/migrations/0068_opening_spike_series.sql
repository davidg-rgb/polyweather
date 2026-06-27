-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0068 · opening-capture spike read-path scaling (the Phase-0.5 gate must survive the 45-city CHECK universe)
--
-- Phase 0.5 widened the keyless CAPTURE universe 10 → 45 cities (0067 + the prod bot.cities config). At */2-min
-- the capture now writes ~45k opening_captures rows/day, each carrying a ~3.4 KB per-bucket jsonb. The Phase-0.5
-- spike (scripts/research/opening-spike.ts — the cheap GO/NO-GO that GATES Phases 2–6) read the FULL series via
-- bot_capture_series(p_days) and reduced per-event in TS. Over an 8-day window that is ~360k rows ≈ 1.2 GB
-- aggregated into ONE jsonb value — past Postgres's 1 GB field limit → the gate would FAIL TO RENDER.
--
-- The spike only ever inspects, per event, captures up to the FIRST one carrying a usable house_gaussian — which
-- must be within the ≤1h flat-open window (≤30 ticks at */2) to be flat-open-relevant. The post-convergence tail
-- (hundreds of captures over an event's 2–3 day life) is never read. So (2) adds a purpose-built read that caps
-- rows per event. bot_capture_series is left UNTOUCHED — the Phase-3 paper backtest needs the full per-tick
-- series for exit replay, and its twin test pins that contract.
--
-- (1) oc_captured_at_idx — capture_deadman_check runs every 10 min doing max(captured_at) + a span min(captured_at)
--     scan, and opening-captures-prune scans captured_at; both grow ~4.5× at 45 cities. A captured_at-leading
--     index serves them. Additive + idempotent.
-- (2) bot_spike_series(p_days, p_cap) — per event, the first p_cap captures by captured_at (covering the flat-open
--     window with margin), same row shape + { rows: [...] } envelope as bot_capture_series (the 0044 port-misread
--     trap: a bare top-level array is read by the service-role port as a RETURNS TABLE rowset). Every event still
--     appears (its earliest captures), so the spike's seededCoverage denominator + every distinct target_date are
--     preserved. Service-role-internal (mirrors the 0034 lockdown + the 0066 grants on bot_capture_series).
--     No table/cron/RLS change beyond the additive index.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════

create index if not exists oc_captured_at_idx on public.opening_captures (captured_at desc);

create or replace function public.bot_spike_series(p_days int, p_cap int default 40)
returns jsonb
language sql
security definer
set search_path = public
as $$
  -- the first p_cap captures per event (earliest captured_at) over the lookback — bounds the aggregated jsonb at
  -- 45-city scale. row_number() ranks within each event; the WHERE rn <= cap filters BEFORE jsonb_agg so the fat
  -- per-bucket payload is built only for the capped head. The spike reduces each event to its FIRST usable-house
  -- capture (within the ≤1h flat-open window ≈ 30 ticks), so the capped head always contains what it scores.
  with capped as (
    select oc.*, row_number() over (partition by oc.event_id order by oc.captured_at) as rn
    from public.opening_captures oc
    where oc.captured_at >= now() - make_interval(days => greatest(coalesce(p_days, 14), 1))
  )
  -- jsonb OBJECT { rows: [...] }, never a top-level array (the 0044 port-misread trap — see bot_capture_series).
  select jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
    'eventId', event_id, 'capturedAt', captured_at, 'city', city, 'targetDate', target_date,
    'tzName', tz_name, 'createdAtGamma', created_at_gamma, 'resolvesAt', resolves_at,
    'hoursSinceListing', hours_since_listing, 'peakMid', peak_mid, 'isFlatOpen', is_flat_open,
    'houseSeeded', house_seeded, 'buckets', buckets, 'evVol24h', ev_vol24h, 'negRisk', neg_risk
  ) order by event_id, captured_at), '[]'::jsonb))
  from capped
  where rn <= greatest(coalesce(p_cap, 40), 1);
$$;

revoke all on function public.bot_spike_series(int, int) from public, anon, authenticated;
grant  execute on function public.bot_spike_series(int, int) to service_role;
