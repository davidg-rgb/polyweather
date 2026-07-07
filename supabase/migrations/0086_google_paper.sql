-- 0086_google_paper.sql — the GOOGLE-PICKS-BUCKET forward-paper panel (the operator's "Test 2").
--
-- THE STRATEGY BEING MEASURED. A PURE TAKER strategy driven only by Google's predicted bucket: across ALL
-- capture-universe cities, per FRESH daily-Tmax market, buy the bucket the latest Google daily-max forecast
-- points at when its taker ask is cheap (execAsk < 0.18), take profit when that bucket's execBid re-rates to
-- ≥ 0.30, stop-loss when it falls to ≤ 0.15, else HOLD to resolution ($1 if the bought bucket wins, $0 else).
-- Taker entry + taker exits, NO time-stop. Forward-accruing: Google is a ~1-week-old forward seed (35/45 cities,
-- ~7 resolved days as of 2026-07-07), so this reads INSUFFICIENT for weeks — it is a forward SEED, not a backtest.
--
-- THE DESIGN (mirror convergence-panel / 0069). A 15-min Edge tick (`google-paper-panel`) pulls the fresh-
-- allowlist capture series PER CITY (google_paper_inputs), joins it to the latest Google source_forecasts row +
-- the city's unit, runs the PURE google-bucket replay view (core/sim/google-bucket-view → buildGoogleView), and
-- stores the small (tens-of-KB) view jsonb. The page reads only the snapshot. NOT trading — read-only analytics;
-- the bot rail stays paper/DORMANT (FINDINGS.md — all twelve signals dead). This panel REPLACES what the
-- /convergence page renders; the 0069 convergence_panel machinery stays intact until the operator cuts over.
--
-- Four objects + one cron:
--   1. google_paper_panel — snapshot table (one row per Edge tick; the page reads the latest).
--   2. record_google_paper(p_view) — service-role insert of one computed view (keeps the latest 200).
--   3. google_paper_inputs(p_days, p_cities) — service-role read of the RAW (downsampled, trimmed-bucket) fresh-
--      allowlist capture series + the venue resolution map + the per-event latest Google forecast (+ unit/tz).
--   4. dash_google_paper() — operator read RPC returning the LATEST snapshot view (security definer + guard).
--   5. pg_cron 'google-paper-panel' every 15 min.

-- === 1. snapshot table ================================================================================
create table if not exists public.google_paper_panel (
  id          bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  view        jsonb       not null
);
create index if not exists google_paper_panel_captured_idx on public.google_paper_panel (captured_at desc);

comment on table public.google_paper_panel is
  'Google-picks-bucket forward-paper view snapshots (google-paper-panel Edge tick, every 15 min): a pure taker '
  'strategy on Google''s predicted bucket (buy execAsk<0.18, TP execBid>=0.30, SL execBid<=0.15, else hold). '
  'Analytics-only; the bot rail stays paper/DORMANT (FINDINGS.md). Google is a ~1-week forward seed.';

-- RLS on (ADR-13): written only by record_google_paper (security definer); no read policy =>
-- anon/authenticated get nothing by direct query. Read via dash_google_paper only.
alter table public.google_paper_panel enable row level security;

-- === 2. record_google_paper — insert one computed view (service-role; the Edge tick's write) ==========
create or replace function public.record_google_paper(p_view jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  insert into public.google_paper_panel (captured_at, view)
  values (now(), coalesce(p_view, '{}'::jsonb))
  returning id into v_id;
  -- keep the table small: retain the latest 200 snapshots (~2 days at 15-min cadence).
  delete from public.google_paper_panel
   where id < (select min(id) from (select id from public.google_paper_panel order by id desc limit 200) k);
  return v_id;
end;
$$;

revoke all on function public.record_google_paper(jsonb) from public, anon, authenticated;
grant  execute on function public.record_google_paper(jsonb) to service_role;

-- === 3. google_paper_inputs — RAW fresh-allowlist capture series + resolutions + per-event Google forecast ==
-- Mirrors convergence_capture_inputs (0069/0073) exactly for the captures + resolutions blocks (same fresh CTE,
-- same ~every-3rd-tick downsample, same 7-field bucket trim + bestBid), and ADDS a `google` block: per fresh
-- event, the latest Google source_forecasts row (source='google', by the event's icao + target_date) + the city's
-- native unit/tz. The TS engine (googleBucketIdx) maps that °C forecast to the ladder bucket idx (°F cities
-- convert first) — so the SQL returns raw forecast + unit, never a bucket. `set statement_timeout='40s'` is the
-- Postgres-level backstop; the Edge handler pages per-city so each statement stays small.
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
    -- downsample to ~every 3rd tick (≈6-min) + always the last tick; the replay is robust to ~6-min granularity.
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
      -- DECISION-read fields the Google replay needs: idx, label (ladder parse → the predicted bucket), execAsk
      -- (the < 0.18 entry gate), execBid (the absolute TP/SL exit). bestAsk/bestBid/depthUsd/houseProb are carried
      -- for RawBucket shape-parity (mapBucket); the Google engine ignores houseProb/depth entirely.
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
  -- one representative (city, target_date) per fresh event (the earliest tick — city/target_date are constant).
  ev_meta as (
    select distinct on (oc.event_id)
           oc.event_id, oc.city, oc.target_date
    from public.opening_captures oc
    join fresh f on f.event_id = oc.event_id
    order by oc.event_id, oc.captured_at
  ),
  -- per fresh event: the latest Google daily-max forecast (by the event's current icao + target_date) + the
  -- city's native unit/tz. tmaxC is NULL for the ~10/45 cities with no Google feed (the TS view renders them as
  -- "no Google data" and never enters). city → current icao via cities → city_stations (valid_to is null).
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

revoke all on function public.google_paper_inputs(int, text[]) from public, anon, authenticated;
grant  execute on function public.google_paper_inputs(int, text[]) to service_role;

-- === 4. dash_google_paper — operator read of the LATEST snapshot view (security definer, jsonb OBJECT) ===
create or replace function public.dash_google_paper()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object('generatedAt', gp.captured_at, 'view', gp.view)
  into v
  from public.google_paper_panel gp
  order by gp.captured_at desc
  limit 1;
  return coalesce(v, jsonb_build_object('generatedAt', null, 'view', null));
end;
$$;

revoke all on function public.dash_google_paper() from public, anon, authenticated;
grant  execute on function public.dash_google_paper() to authenticated, service_role;

-- === 5. cron: 15-min google-paper-panel tick =========================================================
-- Every 15 min — the paper panel moves slowly. Vault-secret pattern identical to 0069's convergence-panel. The
-- Edge fn ACKs fast (202) and runs in waitUntil, so the 4500ms http timeout is the project convention. idempotent;
-- PGlite skips via the guard. The operator deploys the google-paper-panel edge fn alongside applying this
-- migration (until then the cron POST 404s harmlessly).
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping google-paper-panel registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/google-paper-panel',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('google-paper-panel', '*/15 * * * *', edge_command);
end;
$$;
