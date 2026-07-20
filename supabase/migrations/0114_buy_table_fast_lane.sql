-- 0114_buy_table_fast_lane.sql — the buy-table FAST LANE: a slim per-event-latest discovery read + a
-- ~2-min tick cadence scoped to the ONLY hours candidates can exist.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY (operator directive 2026-07-20): the lane ticks every 10 min, so a transient ask dip below a city cap
-- between ticks is never seen — the operator wants ~1-2-min listening for a higher fill rate on price
-- fluctuations. Naively multiplying the cadence would multiply the ONE heavy statement the tick runs:
-- convergence_capture_inputs(2, allowlist) was measured at MEAN 8.2s / MAX 39.6s per call (pg_stat_statements,
-- 2,085 calls) — ~1s producing the jsonb in-DB and the rest serializing a 2-day 20-min-grid capture history
-- out through PostgREST. The tick THROWS AWAY everything but the LATEST capture per event (selection and the
-- resolution sweep both reduce to latest-per-event). 5-10× THAT read is exactly the C15 saturation shape.
--
-- WHAT:
--   1. buy_table_tick_inputs(p_cities, p_days=2) — the tick's OWN discovery read: byte-identical envelope
--      shape to convergence_capture_inputs ({captures:[…], resolutions:[…]}, same bucket keys incl the 0083
--      identity fields) but returns ONLY the latest capture row per event — ~10 rows instead of a 2-day
--      grid. Measured shape: index scan + DISTINCT ON — milliseconds, ~40KB.
--      DELIBERATE DIVERGENCE — NO fresh-listing gate. The convergence read's fresh CTE
--      (min(hours_since_listing) < 1 within the p_days lookback) scopes the REPLAY to events observed from
--      their open — replay economics, irrelevant to buying. Copied onto the buy lane it is a LIVE BUG,
--      measured 2026-07-20: ladders often list ~2.4-3 days before their 12:00Z close, so an event's
--      first-hour rows age OUT of the 2-day lookback BEFORE the [2,12]h buy window opens and the lane goes
--      structurally BLIND to that day's market (07-20: first captured 07-18 04:11 at hours_since_listing
--      0.09-0.13, min within 2d = 1.84-1.88 → excluded — the 05:33/05:43 ticks showed 8 skips, all
--      lead_window, no 07-20 event at all). The tick's own gates (resolved skip, [2,12]h lead window, caps,
--      the entry gate) already bound the universe; a stale past-close event fails the lead window anyway.
--      The fn falls back to convergence_capture_inputs where this RPC is absent (the 42883 staged idiom —
--      the fallback keeps the old, gated behavior until this migration applies).
--   2. cron window split (C15 lane law) — every allowlist city's market closes 12:00Z and the lead window is
--      [lead_min_h, lead_max_h] = [2,12]h, so candidates exist ONLY ~00:00-10:00Z; outside it the tick just
--      books resolution losses + reconciles:
--        · 'buy-table-tick'      → '3,13,23,33,43,53 10-23 * * *' (the existing 10-min lane, off-window)
--        · 'buy-table-tick-fast' → even minutes minus {0,30} (the C15 permanently-bad quarters) minus {12,42}
--          (poll-markets' lane stays sole-tenant), hours 0-9 → 26 fires/hr ≈ every 2.3 min. Remaining
--          co-tenants (whale 2,32 · metar 4,34 · fetch-actuals 20 · google 24 · SQL deadmen) are each light,
--          and the slim read turns the tick's own DB work from ~8s into milliseconds — total DB time SHRINKS
--          vs the old 10-min cadence (144×8.2s ≈ 1,181s/day → ~344 sub-second reads/day).
--      Both jobs POST the same fn with the 0095 §8.1 minute-stamped periodKey body (unique claim per fire at
--      any cadence ≥ 1/min). Daily exposure is UNCHANGED by cadence: the entry gate still allows at most one
--      position per market ever (attempts only retry PROVABLY-dead rows), so the fast lane raises the CHANCE
--      each allowlisted market fills, never how many markets can be bought.
--   3. buy_table_deadman_check() — message text only (the stale wording named the retired */10 cadence; the
--      degraded wording named only the old discovery RPC). Thresholds and logic byte-identical to 0095.
--
-- Deploy order: buy-table-tick edge fn FIRST (it fallback-reads convergence_capture_inputs pre-0114), THEN
-- this migration (the fast cron must never drive the OLD fn's 8.2s read at 26/hr).
-- Cron count 36 → 37.
--
-- 0081 TRIPWIRE COMPLIANCE: buy_table_tick_inputs takes args and returns a jsonb OBJECT envelope.
-- Rollback: drop function public.buy_table_tick_inputs(text[], integer);
--           select cron.unschedule('buy-table-tick-fast');
--           perform cron.schedule('buy-table-tick', '3,13,23,33,43,53 * * * *', <0095 §6 command>);
--           re-apply 0095 §4 for the deadman text.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · buy_table_tick_inputs — latest-capture-per-event discovery (the tick's slim read)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.buy_table_tick_inputs(p_cities text[], p_days integer default 2)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '8s'
as $function$
declare
  v        jsonb;
  v_days   int    := greatest(coalesce(p_days, 2), 1);
  v_cities text[] := coalesce(p_cities, array[]::text[]);
begin
  -- NO fresh-listing gate (see the header): every allowlisted event captured within the window is visible;
  -- the tick's own gates (resolved / [2,12]h lead / caps / entry) bound what it can act on. The convergence
  -- read's fresh CTE is replay-scoping and, on the buy lane, blinded the tick to any market listed ≳2.4
  -- days before close for its ENTIRE buy window (measured 2026-07-20).
  with latest_ids as (
    select distinct on (oc.event_id) oc.id, oc.event_id
      from public.opening_captures oc
     where oc.captured_at > now() - (v_days || ' days')::interval
       and oc.event_id is not null
       and oc.city = any(v_cities)
     order by oc.event_id, oc.captured_at desc, oc.id desc
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
         -- the 0083 venue identity — required by candidate placement.
         'conditionId', b->'conditionId', 'tokenYes', b->'tokenYes', 'tokenNo', b->'tokenNo')
       order by (b->>'idx')::int)
       from jsonb_array_elements(s.buckets) b)   as "buckets"
    from public.opening_captures s
    join latest_ids k on k.id = s.id
    order by s.event_id
  ),
  res as (
    select
      me.id::text as "id",
      coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx)::int as "winnerIdx",
      (me.grading_mismatch = true)                                       as "gradingMismatch"
    from public.market_events me
    where me.id in (select event_id from latest_ids)
  )
  select jsonb_build_object(
    'captures',    coalesce((select jsonb_agg(to_jsonb(caps)) from caps), '[]'::jsonb),
    'resolutions', coalesce((select jsonb_agg(to_jsonb(res)) from res), '[]'::jsonb)
  ) into v;
  return v;
end;
$function$;

revoke all on function public.buy_table_tick_inputs(text[], integer) from public, anon, authenticated;
grant  execute on function public.buy_table_tick_inputs(text[], integer) to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · buy_table_deadman_check — MESSAGE TEXT ONLY (logic + thresholds byte-identical to 0095 §4;
-- the stale wording named the retired */10 cadence, the degraded wording only the old discovery RPC)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.buy_table_deadman_check()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stale_min  numeric := coalesce((select value::numeric from config where key = 'buy_table.tickStaleMin'), 30);
  v_window     int     := coalesce((select value::int from config where key = 'buy_table.degradedWindow'), 6);
  v_latest     timestamptz;
  v_age_min    numeric;
  v_n          int;
  v_deg        int;
  v_alarmed    boolean := false;
  v_bucket     text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');  -- one page per UTC day (0092 policy)
begin
  -- (1) tick staleness — the cron/fn stopped running (arms only once a run exists; a fresh deploy stays silent).
  select max(started_at) into v_latest from public.job_runs where job = 'buy-table-tick';
  if v_latest is not null then
    v_age_min := extract(epoch from (now() - v_latest)) / 60;
    if v_age_min > v_stale_min then
      v_alarmed := true;
      perform public.claim_alert('BUY_TABLE_DEADMAN', 'CRITICAL', 'buy-table-deadman:stale:' || v_bucket,
        'buy-table-tick is STALE',
        'newest buy-table-tick job_runs row is ' || round(v_age_min, 1) || ' min old (> ' || v_stale_min ||
        ' min threshold; the 0114 cadence is ~2-min 00-10Z / 10-min otherwise, so this is many missed '
        || 'ticks). The BUY-TABLE live lane has stopped ticking — no entries are being evaluated and '
        || 'resolution losses are not being booked into the daily-loss kill. Check the buy-table-tick / '
        || 'buy-table-tick-fast crons + the edge fn.');
    end if;

    -- (2) all-degraded — the cron looks alive but EVERY recent ok-run marked itself degraded (discovery /
    -- ledger reads failing): the lane is scanning blind while job_runs stays green. Requires a full window.
    select count(*), count(*) filter (where stats->>'degraded' = 'true')
      into v_n, v_deg
    from (
      select stats from public.job_runs
      where job = 'buy-table-tick' and status = 'ok'
      order by started_at desc limit v_window
    ) q;
    if v_n >= v_window and v_deg = v_n then
      v_alarmed := true;
      perform public.claim_alert('BUY_TABLE_DEADMAN', 'CRITICAL', 'buy-table-deadman:degraded:' || v_bucket,
        'buy-table-tick is DEGRADED every tick',
        'the last ' || v_window || ' completed buy-table-tick runs ALL marked themselves degraded — the '
        || 'discovery read (buy_table_tick_inputs, or its convergence_capture_inputs fallback) or the lane '
        || 'ledger read (buy_table_entries) is failing while the cron itself looks healthy. No candidates '
        || 'can be evaluated. Check the DB reads / statement timeouts.');
    end if;
  end if;

  return jsonb_build_object('checkedAt', now(), 'latestRunAt', v_latest, 'ageMin', v_age_min,
                            'window', v_window, 'degradedInWindow', v_deg, 'alarmed', v_alarmed);
end;
$$;

revoke all on function public.buy_table_deadman_check() from public, anon, authenticated;
grant  execute on function public.buy_table_deadman_check() to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · crons — the window split. Same Vault-secret POST + §8.1 minute-stamped periodKey body as 0095
-- (unique claim per fire at any cadence ≥ 1/min); cron.schedule upserts by name (idempotent re-apply).
-- Fast-lane minute list = even minutes − {0,30} (C15 permanently-bad quarters) − {12,42} (poll-markets stays
-- sole-tenant on its lane). Worst intra-window gap 4 min; cross-window gaps (09:58→10:03, 23:53→00:02) stay
-- far under the 30-min deadman threshold. Cron count 36 → 37.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping buy-table fast-lane registration';
    return;
  end if;

  -- byte-identical to the 0108 command (incl the eu-west-1 REGION PIN — the C44 geoblock fix: default
  -- egress geolocates DE and Polymarket 403-blocks its ORDER endpoint there); only the schedules change.
  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/buy-table-tick',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
    'x-region', 'eu-west-1'
  ),
  body := jsonb_build_object('periodKey', 'buy-table-tick:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI')),
  timeout_milliseconds := 10000
)$cmd$;

  perform cron.schedule('buy-table-tick', '3,13,23,33,43,53 10-23 * * *', edge_command);
  perform cron.schedule('buy-table-tick-fast',
    '2,4,6,8,10,14,16,18,20,22,24,26,28,32,34,36,38,40,44,46,48,50,52,54,56,58 0-9 * * *', edge_command);
end;
$$;
